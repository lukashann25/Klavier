(function(){
  var $ = function(s){ return document.querySelector(s); };
  var LABELS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','H'];
  var isBlack = function(m){ return [1,3,6,8,10].indexOf(m % 12) >= 0; };
  var hz = function(m){ return 440 * Math.pow(2, (m - 69) / 12); };
  var noteName = function(m){ return LABELS[m % 12] + (Math.floor(m / 12) - 1); };

  /* Alle weißen Tasten eines 88er-Klaviers (A0 bis C8). Sichtbar ist ein Ausschnitt davon. */
  var ALLW = [];
  for (var q = 21; q <= 108; q++) if (!isBlack(q)) ALLW.push(q);
  var MIN_KEYS = 5, MAX_KEYS = ALLW.length;
  var VIEW = 'klavier-ansicht-v1';
  var state = {wi:0, count:15, userSet:false, addRight:true, remRight:true};
  var view = 'keyboard';   // keyboard | menu | songs | play
  var geom = new Map();    // Note -> Lage der Taste (Anteil der Breite), für die fallenden Noten
  var keysEl = $('#keys');
  var keyEls = new Map();
  var down = new Set();
  var held = new Map();
  var voices = new Map();
  var sus = new Set();
  var sustain = false, pedalPtr = false, spaceHeld = false;

  /* ---------- Audio ---------- */
  var ctx = null, bus = null, master = null, noiseBuf = null;
  function makeIR(c){
    var len = Math.floor(c.sampleRate * 1.6), b = c.createBuffer(2, len, c.sampleRate);
    for (var ch = 0; ch < 2; ch++){
      var d = b.getChannelData(ch);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8);
    }
    return b;
  }
  function ensureAudio(){
    if (!ctx){
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 4;
      master = ctx.createGain(); master.gain.value = 0.9;
      bus = ctx.createGain();
      var dry = ctx.createGain(); dry.gain.value = 0.92;
      var wet = ctx.createGain(); wet.gain.value = 0.13;
      var conv = ctx.createConvolver(); conv.buffer = makeIR(ctx);
      bus.connect(dry); dry.connect(master);
      bus.connect(conv); conv.connect(wet); wet.connect(master);
      master.connect(comp); comp.connect(ctx.destination);
      var n = Math.floor(ctx.sampleRate * 0.1);
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      var nd = noiseBuf.getChannelData(0);
      for (var i = 0; i < n; i++) nd[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  /* Klavierton: Teiltöne mit leichter Inharmonizität, je zwei verstimmte Saiten für die tiefen Teiltöne,
     höhere Teiltöne klingen schneller ab, dazu ein kurzer Hammer-Anschlag. */
  var AMPS = [1, .6, .34, .22, .12, .07];
  function startVoice(midi, vel){
    var t = ctx.currentTime, f = hz(midi);
    var rg = ctx.createGain(), g = ctx.createGain(), filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 9000; filt.Q.value = 0.5;
    g.gain.value = 1;
    filt.connect(g); g.connect(rg); rg.connect(bus);
    var oscs = [];
    var tau0 = Math.max(0.7, Math.min(3.4, 3.4 - (midi - 36) * 0.04));
    var nP = midi > 84 ? 3 : (midi > 72 ? 4 : 6);
    var peak = 0.17 * vel * (1 + Math.max(0, 60 - midi) * 0.006);
    for (var k = 1; k <= nP; k++){
      var fk = f * k * Math.sqrt(1 + 0.00012 * k * k);
      if (fk > 9000) break;
      var a = AMPS[k - 1] * peak, tk = tau0 / (1 + 0.7 * (k - 1));
      var pg = ctx.createGain();
      pg.gain.setValueAtTime(0, t);
      pg.gain.linearRampToValueAtTime(a, t + 0.004);
      pg.gain.setTargetAtTime(a * 0.4, t + 0.004, 0.09);
      pg.gain.setTargetAtTime(0, t + 0.35, tk);
      pg.connect(filt);
      var dets = k <= 3 ? [1, 1.0004] : [1];
      dets.forEach(function(d){
        var o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.value = fk * d;
        var og = ctx.createGain(); og.gain.value = 1 / dets.length;
        o.connect(og); og.connect(pg); o.start(t);
        oscs.push(o);
      });
    }
    var ns = ctx.createBufferSource(); ns.buffer = noiseBuf;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.min(f * 5, 5000); bp.Q.value = 0.8;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(0.07 * vel, t); ng.gain.setTargetAtTime(0, t, 0.012);
    ns.connect(bp); bp.connect(ng); ng.connect(rg); ns.start(t); ns.stop(t + 0.09);
    return {rg:rg, oscs:oscs, midi:midi};
  }
  function killVoice(v, rel){
    if (!ctx) return;
    var t = ctx.currentTime;
    rel = rel || 0.22;
    v.rg.gain.setTargetAtTime(0, t, rel / 3);
    v.oscs.forEach(function(o){ try { o.stop(t + rel * 2 + 0.3); } catch(e){} });
    sus.delete(v);
  }
  function setKeyOn(m, on){ var el = keyEls.get(m); if (el) el.classList.toggle('on', on); }
  function noteOn(midi, src){
    if (midi < 21 || midi > 108) return;
    if (!ensureAudio()) return;
    held.set(src, midi);
    var old = voices.get(midi); if (old) killVoice(old, 0.05);
    voices.set(midi, startVoice(midi, 0.85));
    down.add(midi); setKeyOn(midi, true);
    if (view === 'play') tryHit(midi);
  }
  function noteOff(src){
    var midi = held.get(src); if (midi == null) return;
    held.delete(src);
    var still = false; held.forEach(function(m){ if (m === midi) still = true; });
    if (still) return;
    down.delete(midi); setKeyOn(midi, false);
    var v = voices.get(midi); if (!v) return;
    if (sustain) sus.add(v);
    else { voices.delete(midi); killVoice(v); }
  }
  /* Pedal: solange gedrückt, klingen losgelassene Töne weiter. Beim Loslassen werden sie gedämpft. */
  function updateSustain(){
    var on = pedalPtr || spaceHeld;
    if (on === sustain) return;
    sustain = on;
    $('#pedal').classList.toggle('down', on);
    if (!on){
      sus.forEach(function(v){
        if (voices.get(v.midi) === v && !down.has(v.midi)) voices.delete(v.midi);
        killVoice(v, 0.3);
      });
      sus.clear();
    }
  }
  var pedalEl = $('#pedal');
  pedalEl.addEventListener('pointerdown', function(e){
    e.preventDefault(); ensureAudio();
    try { pedalEl.setPointerCapture(e.pointerId); } catch(err){}
    pedalPtr = true; updateSustain();
  });
  function pedalUp(){ pedalPtr = false; updateSustain(); }
  pedalEl.addEventListener('pointerup', pedalUp);
  pedalEl.addEventListener('pointercancel', pedalUp);
  pedalEl.addEventListener('contextmenu', function(e){ e.preventDefault(); });

  /* ---------- Tastenbelegung (Computertastatur) ---------- */
  var STORE = 'klavier-tastenbelegung-v1';
  var DEFAULT_KEYS = {a:0,w:1,s:2,e:3,d:4,f:5,t:6,g:7,z:8,h:9,u:10,j:11,k:12,o:13,l:14,p:15,'ö':16,'ä':17};
  var midiToKey = new Map();   // Note -> Taste
  var keyToMidi = new Map();   // Taste -> Note (jede Taste nur einmal)

  function setDefaults(){
    midiToKey.clear(); keyToMidi.clear();
    Object.keys(DEFAULT_KEYS).forEach(function(k){
      var m = 60 + DEFAULT_KEYS[k];
      midiToKey.set(m, k); keyToMidi.set(k, m);
    });
  }
  function save(){
    try {
      var o = {};
      midiToKey.forEach(function(k, m){ o[m] = k; });
      localStorage.setItem(STORE, JSON.stringify(o));
    } catch(e){}
  }
  function load(){
    setDefaults();
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return;
      var o = JSON.parse(raw);
      midiToKey.clear(); keyToMidi.clear();
      Object.keys(o).forEach(function(m){
        var k = o[m], mi = parseInt(m, 10);
        if (typeof k === 'string' && k.length === 1 && k !== ' ' && !keyToMidi.has(k) && mi >= 21 && mi <= 108){
          midiToKey.set(mi, k); keyToMidi.set(k, mi);
        }
      });
    } catch(e){ setDefaults(); }
  }
  /* Taste einer Note zuweisen. Hatte eine andere Note diese Taste, tauschen beide:
     die andere Note bekommt die bisherige Taste dieser Note (oder bleibt ohne Taste). */
  function assign(midi, key){
    var oldKey = midiToKey.get(midi);
    var other = keyToMidi.get(key);
    if (other === midi) return;
    if (other != null){
      midiToKey.delete(other); keyToMidi.delete(key);
      if (oldKey != null){ midiToKey.set(other, oldKey); keyToMidi.set(oldKey, other); }
    } else if (oldKey != null){
      keyToMidi.delete(oldKey);
    }
    midiToKey.set(midi, key); keyToMidi.set(key, midi);
    save();
  }

  /* ---------- Tastatur zeichnen ---------- */
  function clampView(){
    state.count = Math.max(MIN_KEYS, Math.min(MAX_KEYS, state.count));
    state.wi = Math.max(0, Math.min(MAX_KEYS - state.count, state.wi));
  }
  function autoLayout(){
    var avail = keysEl.clientWidth || 600;
    var per = matchMedia('(pointer:coarse)').matches ? 44 : 48;
    state.count = Math.max(8, Math.min(24, Math.floor(avail / per)));
    state.wi = ALLW.indexOf(state.count >= 15 ? 48 : 60);
    clampView();
  }
  function saveView(){
    try { localStorage.setItem(VIEW, JSON.stringify({wi:state.wi, count:state.count})); } catch(e){}
  }
  function loadView(){
    try {
      var o = JSON.parse(localStorage.getItem(VIEW) || 'null');
      if (o && typeof o.wi === 'number' && typeof o.count === 'number'){
        state.wi = o.wi; state.count = o.count; state.userSet = true; clampView(); return true;
      }
    } catch(e){}
    return false;
  }
  /* Eine äußere Taste weniger oder mehr, abwechselnd rechts und links. */
  function changeKeys(delta){
    if (delta < 0){
      if (state.count <= MIN_KEYS) return;
      if (state.remRight) state.count--; else { state.wi++; state.count--; }
      state.remRight = !state.remRight;
    } else {
      if (state.count >= MAX_KEYS) return;
      var canR = state.wi + state.count < MAX_KEYS, canL = state.wi > 0;
      var right = state.addRight ? canR : !canL;
      if (right) state.count++; else { state.wi--; state.count++; }
      state.addRight = !state.addRight;
    }
    state.userSet = true; saveView(); render(); updateVis();
  }
  function render(){
    keysEl.innerHTML = ''; keyEls.clear(); geom.clear();
    var whites = ALLW.slice(state.wi, state.wi + state.count);
    var w = 100 / state.count, bw = w * 0.62;
    keysEl.style.setProperty('--nm', Math.max(11, Math.min(24, (keysEl.clientWidth / state.count) * 0.3)) + 'px');
    function label(mm){
      var k = midiToKey.get(mm);
      return (k ? '<span class="kb">' + k + '</span>' : '') + '<span class="nm">' + noteName(mm) + '</span>';
    }
    whites.forEach(function(m, i){
      var el = document.createElement('div');
      el.className = 'key white'; el.dataset.midi = m;
      el.style.left = (i * w) + '%'; el.style.width = w + '%';
      geom.set(m, {x: i * w / 100, w: w / 100});
      el.innerHTML = label(m);
      keysEl.appendChild(el); keyEls.set(m, el);
      if (i < whites.length - 1 && isBlack(m + 1)){
        var b = document.createElement('div');
        b.className = 'key black'; b.dataset.midi = m + 1;
        b.style.left = ((i + 1) * w - bw / 2) + '%'; b.style.width = bw + '%';
        geom.set(m + 1, {x: ((i + 1) * w - bw / 2) / 100, w: bw / 100});
        b.innerHTML = label(m + 1);
        keysEl.appendChild(b); keyEls.set(m + 1, b);
      }
    });
    down.forEach(function(m){ setKeyOn(m, true); });
  }

  /* ---------- Zeiger (Maus, Touch, Stift) ---------- */
  var ptr = new Map();
  function midiAt(x, y){
    var el = document.elementFromPoint(x, y);
    var k = el && el.closest ? el.closest('.key') : null;
    return k ? parseInt(k.dataset.midi, 10) : null;
  }
  keysEl.addEventListener('pointerdown', function(e){
    e.preventDefault();
    try { keysEl.setPointerCapture(e.pointerId); } catch(err){}
    var m = midiAt(e.clientX, e.clientY);
    ptr.set(e.pointerId, m);
    if (m != null) noteOn(m, 'p' + e.pointerId);
  });
  keysEl.addEventListener('pointermove', function(e){
    if (!ptr.has(e.pointerId)) return;
    var m = midiAt(e.clientX, e.clientY), c = ptr.get(e.pointerId);
    if (m === c) return;
    if (c != null) noteOff('p' + e.pointerId);
    ptr.set(e.pointerId, m);
    if (m != null) noteOn(m, 'p' + e.pointerId);
  });
  function up(e){
    if (!ptr.has(e.pointerId)) return;
    if (ptr.get(e.pointerId) != null) noteOff('p' + e.pointerId);
    ptr.delete(e.pointerId);
  }
  keysEl.addEventListener('pointerup', up);
  keysEl.addEventListener('pointercancel', up);
  keysEl.addEventListener('contextmenu', function(e){ e.preventDefault(); });

  /* ---------- Einstellungen ---------- */
  var overlay = $('#overlay'), listEl = $('#list');
  var rows = new Map();      // Note -> Button
  var listening = null;      // Note, die gerade auf eine Taste wartet
  var FIRST = 24, LAST = 108; // C1 bis C8

  function buildList(){
    listEl.innerHTML = ''; rows.clear();
    for (var m = FIRST; m <= LAST; m++){
      var row = document.createElement('div'); row.className = 'row';
      var nm = document.createElement('span'); nm.className = 'note';
      nm.innerHTML = '<span class="dot' + (isBlack(m) ? ' b' : '') + '"></span>' + noteName(m);
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'keybtn'; btn.dataset.midi = m;
      btn.addEventListener('click', onRowClick);
      row.appendChild(nm); row.appendChild(btn); listEl.appendChild(row);
      rows.set(m, btn);
    }
    refreshRows();
  }
  function refreshRows(){
    rows.forEach(function(btn, m){
      var k = midiToKey.get(m);
      btn.classList.toggle('listening', listening === m);
      btn.classList.toggle('empty', listening !== m && !k);
      btn.textContent = listening === m ? 'Drücke eine Taste' : (k ? k.toUpperCase() : 'nicht belegt');
    });
  }
  function onRowClick(e){
    var m = parseInt(e.currentTarget.dataset.midi, 10);
    listening = (listening === m) ? null : m;
    refreshRows();
  }
  function openSettings(){
    Array.from(held.keys()).forEach(noteOff);
    listening = null; buildList();
    overlay.hidden = false;
    var c4 = rows.get(60);
    if (c4) listEl.scrollTop = Math.max(0, c4.parentNode.offsetTop - listEl.clientHeight / 3);
    $('#close-settings').focus();
  }
  function closeSettings(){
    listening = null; overlay.hidden = true; render();
  }
  var menu = $('#menu'), catcher = $('#menu-catch'), menuBtn = $('#open-menu');
  function setMenu(open){
    menu.hidden = !open; catcher.hidden = !open;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function updateVis(){
    $('#vis-count').textContent = state.count;
    $('#keys-minus').disabled = state.count <= MIN_KEYS;
    $('#keys-plus').disabled = state.count >= MAX_KEYS;
  }
  menuBtn.addEventListener('click', function(){ setMenu(menu.hidden); });
  catcher.addEventListener('pointerdown', function(e){ e.preventDefault(); setMenu(false); });
  $('#keys-minus').addEventListener('click', function(){ changeKeys(-1); });
  $('#keys-plus').addEventListener('click', function(){ changeKeys(1); });
  $('#open-settings').addEventListener('click', function(){ setMenu(false); openSettings(); });
  $('#close-settings').addEventListener('click', closeSettings);
  $('#reset').addEventListener('click', function(){ setDefaults(); save(); listening = null; refreshRows(); });
  overlay.addEventListener('pointerdown', function(e){ if (e.target === overlay) closeSettings(); });

  /* ---------- Computertastatur ---------- */
  window.addEventListener('keydown', function(e){
    if (overlay.hidden && !menu.hidden && e.key === 'Escape'){ e.preventDefault(); setMenu(false); return; }
    if (!overlay.hidden){
      if (e.key === 'Escape'){
        e.preventDefault();
        if (listening != null){ listening = null; refreshRows(); } else closeSettings();
        return;
      }
      if (listening != null){
        e.preventDefault();
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        var nk = (e.key || '');
        if (nk.length !== 1 || nk === ' ') return;
        assign(listening, nk.toLowerCase());
        listening = null; refreshRows();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (view !== 'keyboard' && view !== 'play') return;
    if (e.code === 'Space'){ e.preventDefault(); if (!e.repeat){ spaceHeld = true; updateSustain(); } return; }
    if (e.repeat) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
      e.preventDefault();
      state.wi += (e.key === 'ArrowRight' ? 7 : -7);
      clampView(); saveView(); render(); return;
    }
    var k = (e.key || '').toLowerCase();
    if (keyToMidi.has(k)){
      e.preventDefault(); noteOn(keyToMidi.get(k), 'k:' + k);
    }
  });
  window.addEventListener('keyup', function(e){
    if (e.code === 'Space'){ spaceHeld = false; updateSustain(); return; }
    noteOff('k:' + (e.key || '').toLowerCase());
  });
  window.addEventListener('blur', function(){
    Array.from(held.keys()).forEach(noteOff);
    spaceHeld = false; pedalPtr = false; updateSustain();
  });

  /* ---------- Lieder (alle gemeinfrei) ---------- */
  var PC = {C:0, D:2, E:4, F:5, G:7, A:9, B:11};
  function parseSong(str){
    var out = [];
    str.trim().split(/\s+/).forEach(function(tok){
      var p = tok.split(':'), beats = parseFloat(p[1]);
      if (p[0] === 'R'){ out.push({rest:true, beats:beats}); return; }
      var mm = /^([A-G])(#?)(\d)$/.exec(p[0]);
      out.push({midi: 12 * (parseInt(mm[3], 10) + 1) + PC[mm[1]] + (mm[2] ? 1 : 0), beats:beats});
    });
    return out;
  }
  var SONGS = [
    {title:'Alle meine Entchen', meta:'Kinderlied', level:'sehr leicht', bpm:84,
     data:'C4:1 D4:1 E4:1 F4:1 G4:2 G4:2 A4:1 A4:1 A4:1 A4:1 G4:4 A4:1 A4:1 A4:1 A4:1 G4:4 F4:1 F4:1 F4:1 F4:1 E4:2 E4:2 D4:1 D4:1 D4:1 D4:1 C4:4'},
    {title:'Morgen kommt der Weihnachtsmann', meta:'Kinderlied', level:'sehr leicht', bpm:84,
     data:'C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2 G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2 G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2 C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2'},
    {title:'Hänschen klein', meta:'Kinderlied', level:'leicht', bpm:84,
     data:'G4:1 E4:1 E4:2 F4:1 D4:1 D4:2 C4:1 D4:1 E4:1 F4:1 G4:1 G4:1 G4:2 G4:1 E4:1 E4:1 E4:1 F4:1 D4:1 D4:1 D4:1 C4:1 E4:1 G4:1 G4:1 C4:4'},
    {title:'Ode an die Freude', meta:'Ludwig van Beethoven', level:'leicht', bpm:92,
     data:'E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 E4:1.5 D4:.5 D4:2 E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 D4:1.5 C4:.5 C4:2'},
    {title:'Jingle Bells', meta:'James Lord Pierpont', level:'mittel', bpm:104,
     data:'E4:1 E4:1 E4:2 E4:1 E4:1 E4:2 E4:1 G4:1 C4:1.5 D4:.5 E4:4 F4:1 F4:1 F4:1.5 F4:.5 F4:1 E4:1 E4:1 E4:.5 E4:.5 G4:1 G4:1 F4:1 D4:1 C4:4'},
    {title:'Für Elise', meta:'Ludwig van Beethoven · Anfang', level:'mittel', bpm:76,
     data:'E5:.5 D#5:.5 E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5 A4:1 R:.5 C4:.5 E4:.5 A4:.5 B4:1 R:.5 E4:.5 G#4:.5 B4:.5 C5:1 R:.5 E4:.5 E5:.5 D#5:.5 E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5 A4:1 R:.5 C4:.5 E4:.5 A4:.5 B4:1 R:.5 E4:.5 C5:.5 B4:.5 A4:2'}
  ];
  SONGS.forEach(function(s){ s.parsed = parseSong(s.data); });

  /* ---------- Ansichten ---------- */
  var barTitle = $('#bar-title');
  function setView(v){
    var prev = view;
    Array.from(held.keys()).forEach(noteOff);
    if (prev === 'play' && v !== 'play'){ stopPlay(); restoreView(); }
    view = v; document.body.dataset.view = v; setMenu(false);
    if (v === 'keyboard'){ barTitle.textContent = ''; if (!state.userSet) autoLayout(); render(); updateVis(); }
    if (v === 'songs') barTitle.textContent = 'Spielen lernen';
  }
  $('#go-keyboard').addEventListener('click', function(){ setView('keyboard'); });
  $('#go-learn').addEventListener('click', function(){ setView('songs'); });
  $('#back-btn').addEventListener('click', function(){ setView(view === 'play' ? 'songs' : 'menu'); });

  var songListEl = $('#songlist');
  SONGS.forEach(function(s){
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'songcard';
    b.innerHTML = '<span class="st">' + s.title + '</span><span class="sm">' + s.meta + '</span><span class="chip">' + s.level + '</span>';
    b.addEventListen
