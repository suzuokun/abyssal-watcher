import React, { useRef, useEffect, useState, useCallback } from 'react';
import { db, auth } from './firebase.js';
import { collection, addDoc, getDocs, query, orderBy, limit, deleteDoc, doc } from 'firebase/firestore';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';

/* =========================================================
   深淵絶界 -ABYSSAL WATCHER- (レベル無限昇格版)
   ========================================================= */

const W = 480, H = 720;
const LEVEL_UP_SECONDS = 15; // このタイム毎にレベルアップ
const CLEAR_LEVEL = 60;      // このレベルの監視者を打ち破るとクリア（上位層のみ到達可能な難関ライン）

// 称号システム：到達レベル帯ごとの称号（クリアラインLv.60に合わせて再設計）
const TITLES = [
  { min: 0,  max: 5,  name: '迷い込んだ者',     color: '#6a6780' },
  { min: 6,  max: 12, name: '警戒された影',     color: '#4a9eff' },
  { min: 13, max: 20, name: '狂乱の目撃者',     color: '#ff8844' },
  { min: 21, max: 28, name: '深淵を覗いた者',   color: '#b967ff' },
  { min: 29, max: 36, name: '虚無の同行者',     color: '#ff2d55' },
  { min: 37, max: 44, name: '監視者の残響',     color: '#ffdd55' },
  { min: 45, max: 52, name: '不在なる者',       color: '#00fff2' },
  { min: 53, max: 59, name: '名を持たぬ最果て', color: '#d4af37' },
  { min: 60, max: 9999, name: '深淵絶界の討伐者', color: '#ffffff' }
];
function titleForLevel(level) {
  return TITLES.find(t => level >= t.min && level <= t.max) || TITLES[0];
}

export default function AbyssalWatcher() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const stateRef = useRef(null); // ゲーム内部の可変状態（再レンダリング回避のためref管理）
  const staticBgRef = useRef(null); // グリッド線+ビネットを1度だけ描画したオフスクリーンCanvas(毎フレーム再生成しない)

  const [screen, setScreen] = useState('title'); // title | howto | playing | result | ranking
  const [hudLevel, setHudLevel] = useState(1);
  const [hudTime, setHudTime] = useState(0);
  const [hudLives, setHudLives] = useState(3);
  const [hudGraze, setHudGraze] = useState(0);
  const [isClearSeq, setIsClearSeq] = useState(false);
  const [centerMsg, setCenterMsg] = useState({ text: '', color: '', show: false });
  const [result, setResult] = useState(null);
  const [localStats, setLocalStats] = useState({ attempts: 0, bestLevel: 0, bestTime: 0, cleared: false, history: [] });
  const localStatsLoadedRef = useRef(false);
  const [ranking, setRanking] = useState([]);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [playerName, setPlayerName] = useState('');
  const [submitState, setSubmitState] = useState('idle'); // idle | submitting | done | error
  const [submitErrorMsg, setSubmitErrorMsg] = useState('');

  const inputRef = useRef({ x: W / 2, y: H * 0.82, slow: false, active: false, isTouch: false });
  const TOUCH_Y_OFFSET = 70; // タッチ時、指の位置よりこの分だけ上に自機を表示（指で隠れないように）

  /* ---------------- 管理者パネル（Firebase Auth） ---------------- */
  const [adminUser, setAdminUser] = useState(null);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminLoginError, setAdminLoginError] = useState('');
  const [adminLoginBusy, setAdminLoginBusy] = useState(false);
  const [adminEntries, setAdminEntries] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminDeletingId, setAdminDeletingId] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => setAdminUser(u));
    return unsub;
  }, []);

  // 未ログインで'admin'画面に来た場合はログイン画面へ戻す（防御的なガード）
  useEffect(() => {
    if (screen === 'admin' && !adminUser) setScreen('adminLogin');
  }, [screen, adminUser]);

  const loadAdminEntries = useCallback(async () => {
    setAdminLoading(true);
    try {
      const q = query(collection(db, 'scores'), orderBy('ts', 'desc'), limit(1000));
      const snap = await getDocs(q);
      setAdminEntries(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      setAdminEntries([]);
    }
    setAdminLoading(false);
  }, []);

  useEffect(() => {
    if (screen === 'admin' && adminUser) loadAdminEntries();
  }, [screen, adminUser, loadAdminEntries]);

  async function handleAdminLogin(e) {
    e.preventDefault();
    setAdminLoginBusy(true);
    setAdminLoginError('');
    try {
      await signInWithEmailAndPassword(auth, adminEmail.trim(), adminPassword);
      setAdminPassword('');
      setScreen('admin');
    } catch (err) {
      setAdminLoginError('ログインに失敗した：メールアドレスかパスワードを確認してください。');
    }
    setAdminLoginBusy(false);
  }

  async function handleAdminLogout() {
    await signOut(auth);
    setScreen('title');
  }

  async function handleDeleteEntry(id) {
    if (!window.confirm('この記録を削除しますか？元に戻せません。')) return;
    setAdminDeletingId(id);
    try {
      await deleteDoc(doc(db, 'scores', id));
      setAdminEntries(entries => entries.filter(e => e.id !== id));
    } catch (e) {
      window.alert('削除に失敗しました：' + (e && e.message ? e.message : String(e)));
    }
    setAdminDeletingId(null);
  }

  /* ---------------- デバッグモード（管理者パネルからのみ起動可能） ---------------- */
  const debugRef = useRef({ enabled: false, godMode: false, speedMul: 1 });
  const perfRef = useRef({ lastT: 0, frames: 0 });
  const [debugStartLevel, setDebugStartLevel] = useState(1);
  const [debugGodMode, setDebugGodMode] = useState(false);
  const [debugSpeed, setDebugSpeed] = useState(1);
  const [debugStats, setDebugStats] = useState({ fps: 0, bullets: 0, lasers: 0, particles: 0 });

  /* ---------------- サウンド（Web Audio APIによる合成音源） ---------------- */
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [volume, setVolume] = useState(1); // 0.0〜1.0、UIのスライダーで調整する音量係数
  const volumeRef = useRef(1);
  const [volumeOpen, setVolumeOpen] = useState(false); // 音量スライダーの開閉状態
  const MASTER_GAIN_BASE = 0.75; // ベースとなるマスターゲイン。実際の出力はこれ×volume
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const delayNodeRef = useRef(null);   // 共有ディレイ（残響感を出す）
  const droneNodesRef = useRef(null);  // BGM関連ノード一式
  const bgmLevelRef = useRef(0);       // BGMが現在合わせているレベル帯（不要な再構築を避ける）
  const bgmTickRef = useRef(null);     // リズムパルス用タイマーID

  // レベル → BGM帯（6段階、5レベル刻み）
  function bgmTierForLevel(level) {
    return Math.min(5, Math.floor((level - 1) / 10)); // 10レベル刻みで6段階(0..5)、Lv60到達時に最終段
  }

  function getAudioCtx() {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();

      // リミッター：全体を大きく底上げしても音割れしないよう最終段で圧縮
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 12;
      limiter.ratio.value = 16;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      limiter.connect(ctx.destination);

      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN_BASE * volumeRef.current;
      master.connect(limiter);

      // 共有の短いディレイ（薄いエコーで音に奥行きを出す）
      const delay = ctx.createDelay(1.0);
      delay.delayTime.value = 0.16;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.22;
      const delayFilter = ctx.createBiquadFilter();
      delayFilter.type = 'lowpass'; delayFilter.frequency.value = 2200;
      delay.connect(delayFilter); delayFilter.connect(feedback); feedback.connect(delay);
      delay.connect(master);

      audioCtxRef.current = ctx;
      masterGainRef.current = master;
      delayNodeRef.current = delay;
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    return audioCtxRef.current;
  }

  // dry: 直接出力への送り量, wet: ディレイへの送り量(0で無効)
  function connectOut(node, { dry = 1, wet = 0 } = {}) {
    const ctx = audioCtxRef.current;
    if (dry > 0) {
      const dryGain = ctx.createGain();
      dryGain.gain.value = dry;
      node.connect(dryGain); dryGain.connect(masterGainRef.current);
    }
    if (wet > 0 && delayNodeRef.current) {
      const wetGain = ctx.createGain();
      wetGain.gain.value = wet;
      node.connect(wetGain); wetGain.connect(delayNodeRef.current);
    }
  }

  function playTone({ freq = 440, dur = 0.15, type = 'sine', gain = 0.15, freqEnd = null, delay = 0, wet = 0.12, detune = 0 }) {
    if (mutedRef.current) return;
    try {
      const ctx = getAudioCtx();
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (detune) osc.detune.value = detune;
      if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
      // なめらかなエンベロープ：立ち上がりを少し丸め、減衰を自然にする
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.2));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      connectOut(g, { dry: 1, wet });
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    } catch (_) { /* audio unavailable */ }
  }

  // 2つの波形を重ねて厚みを出す簡易シンセ音
  function playChord({ freqs = [440], dur = 0.2, type = 'sine', gain = 0.1, delay = 0, wet = 0.15 }) {
    freqs.forEach((f, i) => playTone({ freq: f, dur, type, gain: gain / Math.sqrt(freqs.length), delay, wet, detune: i === 0 ? -4 : 4 }));
  }

  function playNoiseBurst({ dur = 0.12, gain = 0.14, delay = 0, filterFreq = 1200, filterType = 'bandpass', wet = 0.1 }) {
    if (mutedRef.current) return;
    try {
      const ctx = getAudioCtx();
      const t0 = ctx.currentTime + delay;
      const bufferSize = Math.floor(ctx.sampleRate * dur);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 1.4);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType; filter.frequency.value = filterFreq;
      filter.Q.value = 1.1;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(filter); filter.connect(g);
      connectOut(g, { dry: 1, wet });
      src.start(t0);
    } catch (_) { /* audio unavailable */ }
  }

  const sfx = {
    // 被弾：低域のインパクト＋歪んだ下降音で「痛み」を表現
    hit: () => {
      playNoiseBurst({ dur: 0.2, gain: 0.28, filterFreq: 500, filterType: 'lowpass', wet: 0.1 });
      playTone({ freq: 190, freqEnd: 55, dur: 0.28, type: 'sawtooth', gain: 0.22, wet: 0.06 });
    },
    // グレイズ：高く短い、澄んだクリック音。連打しても耳障りにならない音量
    graze: () => playTone({ freq: 1600, freqEnd: 2000, dur: 0.045, type: 'sine', gain: 0.05, wet: 0.22 }),
    // レベルアップ：上昇アルペジオ＋和音の余韻
    levelUp: () => {
      const notes = [261.6, 329.6, 392.0, 523.3]; // C-E-G-C 上昇アルペジオ
      notes.forEach((f, i) => playTone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.14, delay: i * 0.055, wet: 0.24 }));
      playChord({ freqs: [523.3, 659.3, 784.0], dur: 0.7, type: 'sine', gain: 0.1, delay: 0.24, wet: 0.32 });
    },
    // 警告：緊迫感のある2音、わずかにディチューンさせてビートを作る
    warning: () => {
      playTone({ freq: 340, dur: 0.09, type: 'square', gain: 0.1, detune: -6, wet: 0.06 });
      playTone({ freq: 340, dur: 0.09, type: 'square', gain: 0.1, delay: 0.13, detune: -6, wet: 0.06 });
    },
    // 強襲警告：警告よりさらに切迫した3連打＋低域うなり
    alert: () => {
      [0, 0.09, 0.18].forEach(d => playTone({ freq: 220, dur: 0.07, type: 'square', gain: 0.12, delay: d, wet: 0.06 }));
      playTone({ freq: 80, dur: 0.5, type: 'sawtooth', gain: 0.1, delay: 0, wet: 0 });
    },
    // 死亡：ノイズの崩壊＋長く沈む下降音
    death: () => {
      playNoiseBurst({ dur: 0.7, gain: 0.26, filterFreq: 250, filterType: 'lowpass', wet: 0.28 });
      playTone({ freq: 150, freqEnd: 25, dur: 1.0, type: 'sawtooth', gain: 0.22, wet: 0.22 });
      playTone({ freq: 100, freqEnd: 20, dur: 1.1, type: 'sine', gain: 0.17, delay: 0.05, wet: 0.22 });
    },
    submit: () => playChord({ freqs: [659.3, 830.6, 987.8], dur: 0.35, type: 'sine', gain: 0.13, wet: 0.26 }),
    click: () => playTone({ freq: 540, dur: 0.05, type: 'triangle', gain: 0.09, wet: 0.12 })
  };

  /* ---- BGM：常時ドローン＋レベル帯ごとに変化するリズムパルス ---- */
  const BGM_TIERS = [
    { baseFreq: 55,   beat: 0.6,  pulseInterval: 900,  pulseNotes: [110],           filterFreq: 900,  waveGain: 0.20 },
    { baseFreq: 58,   beat: 0.8,  pulseInterval: 760,  pulseNotes: [116, 174],       filterFreq: 850,  waveGain: 0.22 },
    { baseFreq: 61.7, beat: 1.1,  pulseInterval: 620,  pulseNotes: [123.5, 185],     filterFreq: 780,  waveGain: 0.24 },
    { baseFreq: 65.4, beat: 1.5,  pulseInterval: 500,  pulseNotes: [130.8, 196, 98], filterFreq: 700,  waveGain: 0.26 },
    { baseFreq: 69.3, beat: 2.0,  pulseInterval: 400,  pulseNotes: [138.6, 207.7],   filterFreq: 620,  waveGain: 0.28 },
    { baseFreq: 73.4, beat: 2.6,  pulseInterval: 320,  pulseNotes: [146.8, 220, 110],filterFreq: 540,  waveGain: 0.30 }
  ];

  function buildDrone(tier) {
    const ctx = getAudioCtx();
    const spec = BGM_TIERS[tier];
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const subGain = ctx.createGain(); // サブベースだけ別経路で強調
    const g = ctx.createGain();
    const boost = ctx.createGain(); // BGM専用の追加ブースト段

    osc1.type = 'sine'; osc1.frequency.value = spec.baseFreq;
    osc2.type = 'sine'; osc2.frequency.value = spec.baseFreq * (1 + 0.011 * spec.beat / 0.6); // 帯が進むほどうなりが速くなる
    sub.type = 'triangle'; sub.frequency.value = spec.baseFreq / 2;

    filter.type = 'lowpass'; filter.frequency.value = spec.filterFreq;
    subGain.gain.value = 1.8; // 低音を持ち上げて音圧の体感を強める

    boost.gain.value = 0.9; // BGM全体の底上げ(さらに控えめに)

    g.gain.value = 0.0001;
    osc1.connect(filter); osc2.connect(filter);
    sub.connect(subGain); subGain.connect(filter);
    filter.connect(g);
    g.connect(boost);
    connectOut(boost, { dry: 1, wet: 0.18 });

    const now = ctx.currentTime;
    g.gain.exponentialRampToValueAtTime(spec.waveGain, now + 1.2);

    osc1.start(); osc2.start(); sub.start();
    return { osc1, osc2, sub, filter, subGain, boost, g, kind: 'raid' };
  }

  // ホーム画面用アンビエントBGM：レイド戦用のドローンとは異なる、
  // ゆったりとした神秘的な旋律。緊迫感は抑え、静かな余韻を持つ音作りにしている。
  const HOME_BGM_NOTES = [220, 261.6, 293.7, 329.6, 246.9]; // A3-C4-D4-E4-B3 の浮遊感のある旋律
  function buildHomeDrone() {
    const ctx = getAudioCtx();
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const boost = ctx.createGain();

    osc1.type = 'sine'; osc1.frequency.value = 110; // レイド戦より低く、穏やかな基音
    osc2.type = 'sine'; osc2.frequency.value = 110 * 1.006; // ごく緩やかなうなり
    sub.type = 'sine'; sub.frequency.value = 55;

    filter.type = 'lowpass'; filter.frequency.value = 500; // レイド戦より丸く柔らかい音色

    boost.gain.value = 0.7;
    g.gain.value = 0.0001;
    osc1.connect(filter); osc2.connect(filter); sub.connect(filter);
    filter.connect(g);
    g.connect(boost);
    connectOut(boost, { dry: 1, wet: 0.28 }); // 残響を多めにして静かな空間の広がりを出す

    const now = ctx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.14, now + 1.8); // レイド戦より控えめな音量、ゆっくりフェードイン

    osc1.start(); osc2.start(); sub.start();
    return { osc1, osc2, sub, filter, boost, g, kind: 'home' };
  }

  function scheduleHomeMelody() {
    if (bgmTickRef.current) clearInterval(bgmTickRef.current);
    let noteIndex = 0;
    bgmTickRef.current = setInterval(() => {
      if (mutedRef.current || !droneNodesRef.current) return;
      const freq = HOME_BGM_NOTES[noteIndex % HOME_BGM_NOTES.length];
      noteIndex++;
      // 単音をゆっくり、残響たっぷりに鳴らす（急かさない旋律）
      playTone({ freq, dur: 1.6, type: 'sine', gain: 0.07, wet: 0.4 });
    }, 2200); // レイド戦のパルスよりゆったりした間隔
  }

  function scheduleBgmPulse(tier) {
    if (bgmTickRef.current) clearInterval(bgmTickRef.current);
    const spec = BGM_TIERS[tier];
    bgmTickRef.current = setInterval(() => {
      if (mutedRef.current || !droneNodesRef.current) return;
      // 低い打点音（キック的な役割）＋ 帯ごとの和声パルス
      playTone({ freq: 60, freqEnd: 30, dur: 0.18, type: 'sine', gain: 0.22, wet: 0 });
      spec.pulseNotes.forEach((f, i) => {
        playTone({ freq: f, dur: 0.5, type: 'triangle', gain: 0.14, delay: 0.02 + i * 0.01, wet: 0.34 });
      });
    }, spec.pulseInterval);
  }

  function startDrone(level = 1, isHome = false) {
    if (mutedRef.current) return;
    if (droneNodesRef.current) return; // 既に鳴っている場合はupdateBgmTierで対応
    try {
      if (isHome) {
        droneNodesRef.current = buildHomeDrone();
        scheduleHomeMelody();
      } else {
        const tier = bgmTierForLevel(level);
        droneNodesRef.current = buildDrone(tier);
        bgmLevelRef.current = tier;
        scheduleBgmPulse(tier);
      }
    } catch (_) { /* audio unavailable */ }
  }

  // レベルが上がりBGM帯が変わるタイミングでクロスフェード（滑らかに切り替える）
  function updateBgmTier(level) {
    if (mutedRef.current || !droneNodesRef.current) return;
    const tier = bgmTierForLevel(level);
    if (tier === bgmLevelRef.current) return;
    try {
      const ctx = getAudioCtx();
      const old = droneNodesRef.current;
      const now = ctx.currentTime;
      // 旧ドローンをフェードアウトして停止
      old.g.gain.cancelScheduledValues(now);
      old.g.gain.setValueAtTime(old.g.gain.value, now);
      old.g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
      const oldNodes = old;
      setTimeout(() => {
        try { oldNodes.osc1.stop(); oldNodes.osc2.stop(); oldNodes.sub.stop(); } catch (_) {}
      }, 1600);

      // 新ドローンをフェードイン
      droneNodesRef.current = buildDrone(tier);
      bgmLevelRef.current = tier;
      scheduleBgmPulse(tier);
    } catch (_) { /* audio unavailable */ }
  }

  function stopDrone() {
    if (bgmTickRef.current) { clearInterval(bgmTickRef.current); bgmTickRef.current = null; }
    if (droneNodesRef.current) {
      try {
        const ctx = audioCtxRef.current;
        const nodes = droneNodesRef.current;
        if (ctx) {
          const now = ctx.currentTime;
          nodes.g.gain.cancelScheduledValues(now);
          nodes.g.gain.setValueAtTime(Math.max(nodes.g.gain.value, 0.0001), now);
          nodes.g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
          setTimeout(() => { try { nodes.osc1.stop(); nodes.osc2.stop(); nodes.sub.stop(); } catch (_) {} }, 450);
        } else {
          nodes.osc1.stop(); nodes.osc2.stop(); nodes.sub.stop();
        }
      } catch (_) {}
      droneNodesRef.current = null;
    }
  }
  function toggleMute() {
    setMuted(m => {
      const next = !m;
      mutedRef.current = next;
      if (next) stopDrone(); else if (stateRef.current?.running) startDrone(stateRef.current.level);
      return next;
    });
  }

  function changeVolume(v) {
    const clamped = Math.max(0, Math.min(1, v));
    setVolume(clamped);
    volumeRef.current = clamped;
    if (masterGainRef.current && audioCtxRef.current) {
      // 急激な変化によるノイズ(クリック音)を避けるため、なめらかに変化させる
      const ctx = audioCtxRef.current;
      const now = ctx.currentTime;
      masterGainRef.current.gain.cancelScheduledValues(now);
      masterGainRef.current.gain.setValueAtTime(masterGainRef.current.gain.value, now);
      masterGainRef.current.gain.linearRampToValueAtTime(MASTER_GAIN_BASE * clamped, now + 0.08);
    }
    // 音量を0にした場合はミュート状態も連動させ、逆に0より上げたらミュート解除する
    if (clamped === 0 && !mutedRef.current) {
      mutedRef.current = true;
      setMuted(true);
      stopDrone();
    } else if (clamped > 0 && mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
      if (stateRef.current?.running) startDrone(stateRef.current.level);
    }
  }

  /* ---------------- ユーティリティ ---------------- */
  const dist2 = (x1, y1, x2, y2) => { const dx = x1 - x2, dy = y1 - y2; return dx * dx + dy * dy; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;
  const hexToRgba = (hex, a) => {
    const v = hex.replace('#', '');
    const r = parseInt(v.substring(0, 2), 16);
    const g = parseInt(v.substring(2, 4),16);
    const bl = parseInt(v.substring(4, 6),16);
    return `rgba(${r},${g},${bl},${a})`;
  };

  /* ---------------- 難易度カーブ ---------------- */
  // レベルに応じて弾幕密度・パターン数・自機狙い精度を変化させる。
  // 弾速は全レベルで固定(等倍)にし、体感操作が変わらないようにしている。
  // 難易度は発射頻度・弾数・way数・追加パターンの解禁テンポだけで作る。
  function diffForLevel(level) {
    const SPAWN_K = 0.0035, SPAWN_P = 1.6; // Lv60でもspawnRateMul=4.0程度に収まる、さらに緩やかなカーブ
    // Lv27-32(fan+homing+dash帯)はLv20-26(flower+laser帯)に比べ弾密度が大きく落ち込みやすいバランス上の弱点があったため、
    // この帯だけring/aimの基礎値を底上げして「難易度の谷」を緩和する(難易度カーブ監査 2026-08-12 所見1)
    const breatherBonus = (level >= 27 && level <= 32) ? 1 : 0;
    return {
      bulletSpeedMul: 1, // 固定：レベルによって弾速は変化しない
      spawnRateMul: 1 + SPAWN_K * Math.pow(level - 1, SPAWN_P),     // 発射間隔を短くする係数として使用(逆数)
      ringCount: Math.min(24, 7 + Math.floor(level * 0.29)) + breatherBonus * 5, // 24発到達をLv60間際まで先送り(所見3)
      aimSpread: Math.min(0.3, 0.14 + level * 0.0027),
      aimWays: Math.min(6, 2 + Math.floor(level / 14)) + breatherBonus,          // 6way到達をLv60間際まで先送り(所見3)
      homingChance: clamp((level - 20) * 0.02, 0, 0.6), // 解禁(Lv27)時点で既にある程度の脅威になるよう早めに立ち上げる(所見2)
      colorPhase: Math.min(3, 1 + Math.floor((level - 1) / 20)) // 色/世界観の変化(20レベル毎、Lv60までに3段階)
    };
  }

  // レベル帯ごとに「今アクティブなギミック」を入れ替え制にする。
  // 一度解禁したギミックを足し算し続けると終盤に全種類が重なって急激に重くなるため、
  // 常時2〜3種類程度に絞ったセットへ切り替えていく(最終決戦Lv60のみ総力戦として全種解放)。
  const GIMMICK_BANDS = [
    { min: 1,  max: 7,  set: [] },
    { min: 8,  max: 13, set: ['spiral'] },
    { min: 14, max: 19, set: ['wall', 'fan'] },
    { min: 20, max: 26, set: ['flower', 'laser'] },
    { min: 27, max: 32, set: ['fan', 'homing', 'dash'] }, // 難易度カーブ監査 所見1: fanを復帰させ谷を底上げ
    { min: 33, max: 39, set: ['teleport', 'spiral'] },
    { min: 40, max: 49, set: ['wall', 'laser', 'dash'] },
    { min: 50, max: 59, set: ['flower', 'homing', 'teleport'] },
    { min: 60, max: 9999, set: ['spiral', 'wall', 'fan', 'flower', 'laser', 'homing', 'dash', 'teleport'] }
  ];
  function activeGimmicks(level) {
    const band = GIMMICK_BANDS.find(b => level >= b.min && level <= b.max) || GIMMICK_BANDS[GIMMICK_BANDS.length - 1];
    return band.set;
  }

  // 実際に弾を撒くギミック(laser/dash/teleportは弾を生成しない別種の脅威なので対象外)。
  // ring/aimなどの基礎パターンはギミックが何個重なっても一切減らず単純加算されてしまい、
  // 終盤(特にLv60の全ギミック同時解放)で画面上の同時弾数が理論値で500発超に達し実質詰みうる状態だったため、
  // 同時発生中の弾ギミック数に応じて全パターンの間隔を延ばす「負荷補正」を導入する(2026-08-12 追加検証)
  const BULLET_GIMMICKS = ['spiral', 'wall', 'flower', 'fan', 'homing'];

  /* ---------------- 初期状態生成 ---------------- */
  function freshState() {
    return {
      player: { x: W / 2, y: H * 0.82, hitRadius: 2.6, drawRadius: 9, lives: 3, invuln: 120, alive: true },
      bullets: [],
      lasers: [],       // { telegraphT, activeT, x1,y1,x2,y2, width, angle, phase }
      particles: [],
      boss: {
        x: W / 2, y: 140, globalT: 0, levelT: 0, flashT: 0, shakeT: 0, hitRadius: 34,
        dashT: 0, dashVX: 0, dashVY: 0, teleportCooldown: 0
      },
      level: 1,
      survivalFrames: 0,
      grazeCount: 0,
      running: false,
      cleared: false,
      clearSeqT: 0,      // クリア撃破演出の経過フレーム(0でない間は演出再生中)
      clearSeqDone: false,
      levelUpFrames: LEVEL_UP_SECONDS * 60
    };
  }

  /* ---------------- 弾幕パターン群（難易度パラメータ受け取り） ---------------- */
  function runPatterns(st) {
    const boss = st.boss;
    const diff = diffForLevel(st.level);
    const t = boss.levelT;
    const gimmicks = activeGimmicks(st.level); // このレベル帯でアクティブな追加ギミック(入れ替え制)
    // 弾を撒くギミックが同時に何個アクティブかに応じて、以降の全パターンの間隔を延ばす負荷補正。
    // ring/aim等の基礎パターンは元々ギミック数に関係なく一定量発射されるため、ギミックが積み上がるほど
    // 単純加算で画面が埋まってしまう問題があった(Lv60で理論上の同時弾数が500発を超えていた)。
    const activeBulletGimmickCount = gimmicks.filter(g => BULLET_GIMMICKS.includes(g)).length;
    const loadComp = 1 + activeBulletGimmickCount * 0.35;

    // リング弾（弾数・頻度を大幅に抑えた基礎パターン）
    const ringInterval = Math.max(24, Math.round(70 / diff.spawnRateMul * loadComp));
    if (t % ringInterval === 0) {
      const n = diff.ringCount;
      const rot = (t / ringInterval) * 0.25;
      for (let i = 0; i < n; i++) {
        const ang = (Math.PI * 2 / n) * i + rot;
        const spd = 2.1 * diff.bulletSpeedMul;
        spawnBullet(st, { x: boss.x, y: boss.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, r: 5, color: colorFor(diff, 'ring') });
      }
    }

    // 自機狙い（way数・拡散角がレベルで緩やかに増加）
    const aimInterval = Math.max(26, Math.round(48 / diff.spawnRateMul * loadComp));
    if (t % aimInterval === 0) {
      const dx = st.player.x - boss.x, dy = st.player.y - boss.y;
      const base = Math.atan2(dy, dx);
      const ways = diff.aimWays;
      const spread = diff.aimSpread;
      const spd = 3.4 * diff.bulletSpeedMul;
      for (let i = 0; i < ways; i++) {
        const off = ways === 1 ? 0 : (i / (ways - 1) - 0.5) * spread * 2;
        const ang = base + off;
        spawnBullet(st, { x: boss.x, y: boss.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, r: 4.5, color: colorFor(diff, 'aim') });
      }
    }

    // 螺旋（このレベル帯でアクティブな場合のみ、間隔を大幅に延長）
    if (gimmicks.includes('spiral')) {
      const spiralInterval = Math.max(9, Math.round(14 / diff.spawnRateMul * loadComp));
      if (t % spiralInterval === 0) {
        const rot = t * (0.09 + st.level * 0.0015);
        [0, Math.PI].forEach(off => {
          const ang = rot + off;
          const spd = 2.6 * diff.bulletSpeedMul;
          spawnBullet(st, { x: boss.x, y: boss.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, r: 4.2, color: colorFor(diff, 'spiral') });
        });
      }
    }

    // 壁弾（このレベル帯でアクティブな場合のみ、隙間を広く・間隔を延長）
    // wallとlaser(横方向)はどちらも「安全なY座標」を独立した乱数で決めるため、両方が同時にアクティブだと
    // 安全帯が噛み合わず回避不可能な瞬間が生じうる(難易度カーブ監査フォローアップで実測: 該当帯の約85%のランで発生)。
    // 横方向laserが予告・発射中は壁弾の発生を見送ることで、この組み合わせ事故を構造的に防ぐ。
    if (gimmicks.includes('wall')) {
      const wallInterval = Math.max(80, Math.round(150 / diff.spawnRateMul * loadComp));
      if (t % wallInterval === 0 && !hasActiveHorizontalLaser(st)) {
        const gapY = rand(H * 0.25, H * 0.75);
        const gapSize = Math.max(110, 170 - st.level);
        const spd = 3.4 * diff.bulletSpeedMul;
        for (let y = 20; y < H - 20; y += 26) {
          if (Math.abs(y - gapY) < gapSize / 2) continue;
          spawnBullet(st, { x: -10, y, vx: spd, vy: 0, r: 5, color: colorFor(diff, 'wall'), wallBullet: true });
        }
      }
    }

    // 花状弾幕（このレベル帯でアクティブな場合のみ、腕数を抑え間隔を延長）
    // 解禁直後(Lv20)にほぼ最速間隔へ達してしまい急激な難易度スパイクになっていたため、
    // 間隔の下限と腕数の増加ペースを緩め、Lv20〜59にかけてより長くランプアップするよう調整(難易度カーブ監査 所見1,3)
    if (gimmicks.includes('flower')) {
      const flowerInterval = Math.max(10, Math.round(15 / diff.spawnRateMul * loadComp));
      if (t % flowerInterval === 0) {
        const arms = Math.min(5, 3 + Math.floor(st.level / 22));
        const rot = t * 0.045;
        const spd = 2.3 * diff.bulletSpeedMul;
        for (let i = 0; i < arms; i++) {
          const ang = rot + (Math.PI * 2 / arms) * i;
          spawnBullet(st, { x: boss.x, y: boss.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, r: 3.6, color: colorFor(diff, 'flower') });
        }
      }
    }

    // 誘導弾（このレベル帯でアクティブな場合のみ）
    // 旧式は150フレームに1回・homingChance×0.5でしか判定せず、上限でも期待値0.2発/秒と
    // ほぼ無音のギミックになっていたため、判定間隔を短縮し発動率に下限を設けて実際に脅威になるよう強化(所見2)
    if (gimmicks.includes('homing')) {
      const homingInterval = Math.max(50, Math.round(90 / diff.spawnRateMul * loadComp));
      if (t % homingInterval === 0 && Math.random() < Math.max(0.35, diff.homingChance)) {
        const n = st.level >= 45 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          spawnBullet(st, {
            x: boss.x + rand(-40, 40), y: boss.y, vx: rand(-0.5, 0.5), vy: 1.2,
            r: 6, color: colorFor(diff, 'homing'), homing: true, spd: 1.4 * diff.bulletSpeedMul
          });
        }
      }
    }

    // 扇状バースト（このレベル帯でアクティブな場合のみ）：本数を抑え間隔を延長
    // Lv27-32帯の底上げに再登板させたため、間隔の下限をわずかに縮めて存在感を持たせる(所見1)
    if (gimmicks.includes('fan')) {
      const fanInterval = Math.max(70, Math.round(160 / diff.spawnRateMul * loadComp));
      if (t % fanInterval === 0) {
        const dx = st.player.x - boss.x, dy = st.player.y - boss.y;
        const base = Math.atan2(dy, dx);
        const fanN = Math.min(9, 5 + Math.floor(st.level / 15));
        const fanWidth = Math.PI * 0.55;
        const spd = 2.5 * diff.bulletSpeedMul;
        for (let i = 0; i < fanN; i++) {
          const ang = base + (i / (fanN - 1) - 0.5) * fanWidth;
          spawnBullet(st, { x: boss.x, y: boss.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, r: 4, color: colorFor(diff, 'flower') });
        }
      }
    }

    // レーザー予告→発射（このレベル帯でアクティブな場合のみ）：間隔を延長、隙間を広く
    // 壁弾が画面上に飛んでいる間は、横方向(Y軸で競合しうる)ではなく縦方向に固定して衝突事故を防ぐ
    if (gimmicks.includes('laser')) {
      const laserInterval = Math.max(220, Math.round(320 / diff.spawnRateMul));
      if (t % laserInterval === 0) {
        spawnLaser(st, hasWallBulletsInFlight(st));
      }
    }

    // ボス高速突進（このレベル帯でアクティブな場合のみ）：間隔を延長
    if (gimmicks.includes('dash') && boss.dashT <= 0 && boss.teleportCooldown <= 0 && t % 320 === 0) {
      const dx = st.player.x - boss.x, dy = st.player.y - boss.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      boss.dashVX = (dx / d) * 7 * diff.bulletSpeedMul;
      boss.dashVY = (dy / d) * 7 * diff.bulletSpeedMul;
      boss.dashT = 22;
      sfx.warning();
    }

    // ボス瞬間移動（このレベル帯でアクティブな場合のみ）：頻度を下げる
    if (gimmicks.includes('teleport') && boss.teleportCooldown <= 0 && t % 400 === 0 && Math.random() < 0.4) {
      boss.teleportCooldown = 60;
      boss.flashT = 20;
    }
  }

  // 壁弾が画面上に飛んでいるか（wall/laser同時発生時の安全帯衝突を避けるための判定）
  function hasWallBulletsInFlight(st) {
    return st.bullets.some(b => b.wallBullet);
  }
  // 横方向のレーザーが予告中または発射中か（同上）
  function hasActiveHorizontalLaser(st) {
    return st.lasers.some(l => !l.vertical && (l.telegraphT > 0 || l.activeT > 0));
  }

  function spawnLaser(st, forceVertical) {
    const boss = st.boss;
    // 縦・横どちらかランダムに、狭い隙間を持つレーザー予告→発射
    // forceVertical: 壁弾が飛行中の場合はY軸競合を避けるため縦方向に固定する
    const vertical = forceVertical || Math.random() < 0.5;
    const gapPos = vertical ? rand(W * 0.2, W * 0.8) : rand(H * 0.3, H * 0.7);
    const gapSize = Math.max(60, 100 - st.level);
    st.lasers.push({
      vertical, gapPos, gapSize,
      telegraphT: 55,   // 予告表示フレーム数（この間は当たらない）
      activeT: 26,      // 発射時間（この間は当たる）
      done: false
    });
  }

  function colorFor(diff, type) {
    const palettes = [
      { ring: '#ff4466', aim: '#4a9eff', spiral: '#b967ff', wall: '#ff8844', flower: '#ffdd55', homing: '#ff3355' },
      { ring: '#ff2d55', aim: '#00d4ff', spiral: '#d94fff', wall: '#ffb020', flower: '#ffe74c', homing: '#ff0844' },
      { ring: '#ff0044', aim: '#00fff2', spiral: '#ff2dff', wall: '#ff6a00', flower: '#fff200', homing: '#ff003c' }
    ];
    const p = palettes[Math.min(2, diff.colorPhase - 1)];
    return p[type] || '#ffffff';
  }

  function spawnBullet(st, o) {
    st.bullets.push(Object.assign({ x: 0, y: 0, vx: 0, vy: 0, r: 4, color: '#ff3355', age: 0, trail: [] }, o));
  }

  /* ---------------- 更新処理 ---------------- */
  function updatePlayer(st) {
    const input = inputRef.current;
    const p = st.player;
    if (!p.alive) return;
    if (input.slow) {
      // 低速・精密回避モードのみ、わずかな慣性を残して微調整しやすくする
      p.x = lerp(p.x, input.x, 0.5);
      p.y = lerp(p.y, input.y, 0.5);
    } else {
      // 通常モードはカーソル位置に即座追従（遅延ゼロ、最も精密な操作感を優先）
      p.x = input.x;
      p.y = input.y;
    }
    p.x = clamp(p.x, 12, W - 12);
    p.y = clamp(p.y, 12, H - 12);
    if (p.invuln > 0) p.invuln--;
  }

  /* ---------------- クリア撃破演出 ---------------- */
  const CLEAR_SEQ = {
    freeze: 45,     // 静止＋亀裂
    shake: 130,     // 激しい振動とパーティクル爆発
    burst: 195,     // 最終大爆発・白フラッシュ
    fade: 260       // フェードアウト完了 → finishRun
  };

  function updateClearSequence(st) {
    st.clearSeqT++;
    const t = st.clearSeqT;
    const boss = st.boss;

    if (t === 1) {
      st.bullets = [];
      st.lasers = [];
    }

    if (t < CLEAR_SEQ.freeze) {
      // 静止フェーズ：ボスがビキビキと亀裂音を立てる演出用の微振動
      boss.shakeT = t % 8 < 2 ? 3 : 0;
    } else if (t < CLEAR_SEQ.shake) {
      // 振動＋段階的爆発フェーズ
      boss.shakeT = 6;
      boss.flashT = 6;
      if (t % 6 === 0) {
        spawnHitParticles(st, boss.x + rand(-20, 20), boss.y + rand(-20, 20));
        playNoiseBurst({ dur: 0.15, gain: 0.2, filterFreq: 700, filterType: 'bandpass', wet: 0.15 });
      }
      if (t % 18 === 0) sfx.warning();
    } else if (t < CLEAR_SEQ.burst) {
      // 最終大爆発フェーズ：一度だけ大量のパーティクルと白フラッシュ
      if (t === CLEAR_SEQ.shake) {
        for (let i = 0; i < 80; i++) {
          const ang = rand(0, Math.PI * 2);
          const spd = rand(2, 10);
          st.particles.push({
            x: boss.x, y: boss.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
            life: 60, maxLife: 60, color: i % 3 === 0 ? '#ffffff' : (i % 3 === 1 ? '#d4af37' : '#ff2d55')
          });
        }
        boss.flashT = 40;
        boss.shakeT = 35;
        playNoiseBurst({ dur: 0.8, gain: 0.4, filterFreq: 300, filterType: 'lowpass', wet: 0.3 });
        playTone({ freq: 60, freqEnd: 900, dur: 0.6, type: 'sawtooth', gain: 0.3, wet: 0.2 });
        // 勝利ファンファーレ：荘厳な上昇和音
        [0, 0.15, 0.3, 0.5].forEach((d, i) => {
          playChord({ freqs: [261.6 * Math.pow(2, i / 4), 329.6 * Math.pow(2, i / 4), 392.0 * Math.pow(2, i / 4)], dur: 1.0, type: 'triangle', gain: 0.16, delay: d, wet: 0.35 });
        });
      }
    } else if (t < CLEAR_SEQ.fade) {
      // フェードアウトフェーズ：ボスは既に消滅、静寂の中で光の残滓が消えていく
    } else {
      st.clearSeqDone = true;
      st.running = false;
      finishRun(st, true);
    }
  }

  function updateBoss(st) {
    const boss = st.boss;
    boss.globalT++;
    boss.levelT++;
    if (boss.flashT > 0) boss.flashT--;
    if (boss.shakeT > 0) boss.shakeT--;
    if (boss.teleportCooldown > 0) boss.teleportCooldown--;
    const diff = diffForLevel(st.level);

    if (boss.dashT > 0) {
      // 高速突進中：直線移動、通常軌道は無視
      boss.x += boss.dashVX;
      boss.y += boss.dashVY;
      boss.x = clamp(boss.x, 40, W - 40);
      boss.y = clamp(boss.y, 60, H * 0.55);
      boss.dashT--;
    } else if (boss.teleportCooldown > 45) {
      // 瞬間移動発動の瞬間
      boss.x = rand(W * 0.25, W * 0.75);
      boss.y = rand(90, 220);
    } else {
      const moveSpeed = 0.02 + Math.min(0.05, st.level * 0.0018);
      boss.x = W / 2 + Math.sin(boss.globalT * moveSpeed) * (W * 0.28);
      boss.y = 130 + Math.sin(boss.globalT * moveSpeed * 0.6) * 22;
    }

    runPatterns(st);
    updateLasers(st);
  }

  function updateLasers(st) {
    for (let i = st.lasers.length - 1; i >= 0; i--) {
      const l = st.lasers[i];
      if (l.telegraphT > 0) {
        l.telegraphT--;
        if (l.telegraphT === 0) sfx.warning();
      } else if (l.activeT > 0) {
        l.activeT--;
        // 判定：隙間以外に自機がいれば被弾
        const p = st.player;
        if (p.alive && p.invuln <= 0) {
          const inGap = l.vertical
            ? Math.abs(p.x - l.gapPos) < l.gapSize / 2
            : Math.abs(p.y - l.gapPos) < l.gapSize / 2;
          if (!inGap) onPlayerHit(st);
        }
      } else {
        st.lasers.splice(i, 1);
      }
    }
  }


  function updateLevel(st) {
    if (st.cleared) return; // クリア済みなら以降のレベル進行は止める
    st.levelUpFrames--;
    // レベルアップ2秒前に警告音
    if (st.levelUpFrames === 120) sfx.warning();
    if (st.levelUpFrames <= 0) {
      // クリアライン到達：このレベルを耐えきったら勝利 → 撃破演出フェーズへ
      if (st.level >= CLEAR_LEVEL) {
        st.cleared = true;
        st.clearSeqT = 1; // 演出開始（updateClearSequenceが以降を処理する）
        setCenterMsg({ text: '', show: false }); // 通常のレベルアップ表示は消す(演出はCanvas側で描く)
        setIsClearSeq(true);
        sfx.levelUp();
        stopDrone();
        return;
      }
      st.level++;
      st.levelUpFrames = LEVEL_UP_SECONDS * 60;
      st.boss.levelT = 0;
      st.boss.flashT = 40;
      st.boss.shakeT = 30;
      st.player.invuln = 80;
      sfx.levelUp();
      updateBgmTier(st.level);
      const newTitle = titleForLevel(st.level);
      const prevTitle = titleForLevel(st.level - 1);
      if (newTitle.name !== prevTitle.name) {
        triggerCenterMsg(`LEVEL ${st.level}\n「${newTitle.name}」`, newTitle.color);
      } else if (st.level === CLEAR_LEVEL) {
        triggerCenterMsg(`LEVEL ${st.level}\n最終決戦`, '#ff2d55');
      } else {
        triggerCenterMsg(`LEVEL ${st.level}`, '#d4af37');
      }
    }
  }

  function updateBullets(st) {
    const p = st.player;
    for (let i = st.bullets.length - 1; i >= 0; i--) {
      const b = st.bullets[i];
      b.age++;
      if (b.homing) {
        const dx = p.x - b.x, dy = p.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        b.vx = lerp(b.vx, (dx / d) * b.spd, 0.02);
        b.vy = lerp(b.vy, (dy / d) * b.spd, 0.02);
      }
      b.x += b.vx; b.y += b.vy;
      if (b.age % 2 === 0) { b.trail.push({ x: b.x, y: b.y }); if (b.trail.length > 5) b.trail.shift(); }
      if (b.x < -30 || b.x > W + 30 || b.y < -30 || b.y > H + 30) { st.bullets.splice(i, 1); continue; }

      if (p.alive && p.invuln <= 0) {
        const rr = p.hitRadius + b.r * 0.5;
        if (dist2(b.x, b.y, p.x, p.y) < rr * rr) {
          onPlayerHit(st);
          st.bullets.splice(i, 1);
          continue;
        }
        const grazeR = p.hitRadius + b.r + 10;
        if (dist2(b.x, b.y, p.x, p.y) < grazeR * grazeR && !b._grazed) {
          b._grazed = true;
          st.grazeCount++;
          if (st.grazeCount % 5 === 0) sfx.graze(); // 音の洪水を避けるため間引き
        }
      }
    }
  }

  function onPlayerHit(st) {
    if (debugRef.current.enabled && debugRef.current.godMode) {
      // 無敵モード：被弾演出だけ再生し、実際のダメージ処理は行わない
      st.player.invuln = 30;
      st.boss.shakeT = 10;
      spawnHitParticles(st, st.player.x, st.player.y);
      sfx.hit();
      return;
    }
    st.player.lives--;
    st.player.invuln = 100;
    st.boss.shakeT = 18;
    spawnHitParticles(st, st.player.x, st.player.y);
    setHudLives(st.player.lives);
    if (st.player.lives <= 0) {
      st.player.alive = false;
      st.running = false;
      sfx.death();
      stopDrone();
      finishRun(st);
    } else {
      sfx.hit();
    }
  }

  function spawnHitParticles(st, x, y) {
    for (let i = 0; i < 18; i++) {
      const ang = rand(0, Math.PI * 2);
      const spd = rand(1, 5);
      st.particles.push({ x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, life: 30, maxLife: 30, color: '#ff3355' });
    }
  }

  function updateParticles(st) {
    for (let i = st.particles.length - 1; i >= 0; i--) {
      const pt = st.particles[i];
      pt.x += pt.vx; pt.y += pt.vy;
      pt.vx *= 0.94; pt.vy *= 0.94;
      pt.life--;
      if (pt.life <= 0) st.particles.splice(i, 1);
    }
  }

  /* ---------------- センターメッセージ ---------------- */
  const centerMsgTimerRef = useRef(0);
  function triggerCenterMsg(text, color) {
    setCenterMsg({ text, color, show: true });
    centerMsgTimerRef.current = 70;
  }

  /* ---------------- 描画 ---------------- */
  // グリッド線・ビネットは毎フレーム変化しない静的な要素なので、初回だけオフスクリーンCanvasに
  // 描画してキャッシュしておき、以後は drawImage で1回貼るだけにする(createRadialGradient等の再計算を省く)
  function getStaticBg() {
    if (staticBgRef.current) return staticBgRef.current;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d');

    octx.strokeStyle = 'rgba(255,255,255,0.02)';
    octx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, H); octx.stroke(); }

    staticBgRef.current = off;
    return off;
  }

  function draw(ctx, st) {
    const diff = diffForLevel(st.level);
    ctx.fillStyle = '#050408';
    ctx.fillRect(0, 0, W, H);

    const g = ctx.createRadialGradient(st.boss.x, st.boss.y, 20, st.boss.x, st.boss.y, 420);
    g.addColorStop(0, 'rgba(196,30,58,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.drawImage(getStaticBg(), 0, 0); // 静的なグリッド線を1回で貼り付け(ビネットはこの後、最前面にも重ねて描く)

    // ボス
    ctx.save();
    let sx = 0, sy = 0;
    if (st.boss.shakeT > 0) { sx = rand(-4, 4); sy = rand(-4, 4); }
    ctx.translate(st.boss.x + sx, st.boss.y + sy);
    const pulse = 1 + Math.sin(st.boss.globalT * 0.05) * 0.05;
    const flashOn = st.boss.flashT > 0 && Math.floor(st.boss.flashT / 4) % 2 === 0;
    const glowR = st.boss.hitRadius * 2.4 * pulse;
    const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, glowR);
    const coreColor = flashOn ? '#ffffff' : colorFor(diff, 'ring');
    grad.addColorStop(0, coreColor);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, glowR, 0, Math.PI * 2); ctx.fill();

    const sides = Math.min(14, 5 + Math.floor(st.level / 3));
    const rot = st.boss.globalT * 0.01;
    ctx.strokeStyle = flashOn ? '#fff' : coreColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= sides; i++) {
      const ang = rot + (Math.PI * 2 / sides) * i;
      const r = st.boss.hitRadius * pulse;
      const px = Math.cos(ang) * r, py = Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.stroke();

    ctx.fillStyle = flashOn ? '#fff' : '#0a0a12';
    ctx.beginPath(); ctx.arc(0, 0, st.boss.hitRadius * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = coreColor; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();

    // レーザー（予告線 → 発射）
    for (const l of st.lasers) {
      ctx.save();
      if (l.telegraphT > 0) {
        const blink = Math.floor(l.telegraphT / 6) % 2 === 0;
        ctx.strokeStyle = blink ? 'rgba(255,60,60,0.75)' : 'rgba(255,60,60,0.3)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        if (l.vertical) {
          ctx.beginPath(); ctx.moveTo(l.gapPos - l.gapSize / 2, 0); ctx.lineTo(l.gapPos - l.gapSize / 2, H); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(l.gapPos + l.gapSize / 2, 0); ctx.lineTo(l.gapPos + l.gapSize / 2, H); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(0, l.gapPos - l.gapSize / 2); ctx.lineTo(W, l.gapPos - l.gapSize / 2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, l.gapPos + l.gapSize / 2); ctx.lineTo(W, l.gapPos + l.gapSize / 2); ctx.stroke();
        }
        ctx.setLineDash([]);
      } else if (l.activeT > 0) {
        ctx.fillStyle = 'rgba(255,45,85,0.85)';
        if (l.vertical) {
          ctx.fillRect(0, 0, l.gapPos - l.gapSize / 2, H);
          ctx.fillRect(l.gapPos + l.gapSize / 2, 0, W - (l.gapPos + l.gapSize / 2), H);
        } else {
          ctx.fillRect(0, 0, W, l.gapPos - l.gapSize / 2);
          ctx.fillRect(0, l.gapPos + l.gapSize / 2, W, H - (l.gapPos + l.gapSize / 2));
        }
      }
      ctx.restore();
    }

    // 弾（shadowBlurは非常に重いため使わず、内側に明るいコアを重ねるだけの軽量な光彩表現にする）
    for (const b of st.bullets) {
      for (let i = 0; i < b.trail.length; i++) {
        const tp = b.trail[i];
        const alpha = (i / b.trail.length) * 0.35;
        ctx.fillStyle = hexToRgba(b.color, alpha);
        ctx.beginPath(); ctx.arc(tp.x, tp.y, b.r * 0.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.35, 0, Math.PI * 2); ctx.fill();
    }

    // タッチ操作中：指の実位置と自機を結ぶガイド線（自機がずれて表示されることを分かりやすくする）
    if (inputRef.current.isTouch) {
      const fingerY = clamp(inputRef.current.y + 70, 12, H - 12);
      ctx.save();
      ctx.strokeStyle = 'rgba(212,175,55,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(st.player.x, st.player.y);
      ctx.lineTo(inputRef.current.x, fingerY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(212,175,55,0.15)';
      ctx.beginPath();
      ctx.arc(inputRef.current.x, fingerY, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // プレイヤー
    const p = st.player;
    if (p.alive) {
      const blinking = p.invuln > 0 && Math.floor(p.invuln / 4) % 2 === 0;
      if (!blinking) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.strokeStyle = inputRef.current.slow ? 'rgba(212,175,55,0.9)' : 'rgba(200,220,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, -p.drawRadius);
        ctx.lineTo(p.drawRadius * 0.7, p.drawRadius * 0.8);
        ctx.lineTo(0, p.drawRadius * 0.4);
        ctx.lineTo(-p.drawRadius * 0.7, p.drawRadius * 0.8);
        ctx.closePath(); ctx.stroke();
        if (inputRef.current.slow) {
          ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.stroke();
        }
        // 自機の視認性を保つ薄いグロー(shadowBlurの代わりに二重円で軽量に表現)
        ctx.fillStyle = 'rgba(255,51,85,0.35)';
        ctx.beginPath(); ctx.arc(0, 0, p.hitRadius * 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(0, 0, p.hitRadius, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }

    // パーティクル
    for (const pt of st.particles) {
      const a = pt.life / pt.maxLife;
      ctx.fillStyle = hexToRgba(pt.color, a);
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2); ctx.fill();
    }

    // ビネット
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  function drawClearSequence(ctx, st) {
    const t = st.clearSeqT;
    const boss = st.boss;
    const diff = diffForLevel(st.level);

    ctx.fillStyle = '#050408';
    ctx.fillRect(0, 0, W, H);

    // 背景：フェーズが進むほど白く染まっていく
    let bgFlash = 0;
    if (t >= CLEAR_SEQ.shake && t < CLEAR_SEQ.burst) {
      bgFlash = 0.5 * (1 - Math.abs((t - CLEAR_SEQ.shake) / (CLEAR_SEQ.burst - CLEAR_SEQ.shake) - 0.15) * 3);
      bgFlash = clamp(bgFlash, 0, 0.9);
    }
    if (bgFlash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${bgFlash})`;
      ctx.fillRect(0, 0, W, H);
    }

    // ボス本体：burstフェーズ以降は消滅していく
    if (t < CLEAR_SEQ.burst) {
      ctx.save();
      let sx = 0, sy = 0;
      if (boss.shakeT > 0) { sx = rand(-5, 5); sy = rand(-5, 5); }
      ctx.translate(boss.x + sx, boss.y + sy);

      const flashOn = boss.flashT > 0 && Math.floor(boss.flashT / 3) % 2 === 0;
      const coreColor = flashOn ? '#ffffff' : colorFor(diff, 'ring');

      // 亀裂フェーズ以降、コアの多角形が徐々に歪んでいく
      const distortion = t >= CLEAR_SEQ.freeze ? Math.min(1, (t - CLEAR_SEQ.freeze) / (CLEAR_SEQ.shake - CLEAR_SEQ.freeze)) : 0;
      const sides = Math.min(14, 5 + Math.floor(st.level / 3));
      const rot = boss.globalT * 0.01;
      ctx.strokeStyle = coreColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i <= sides; i++) {
        const ang = rot + (Math.PI * 2 / sides) * i;
        const jitter = distortion * rand(-8, 8);
        const r = boss.hitRadius * (1 + distortion * 0.3) + jitter;
        const px = Math.cos(ang) * r, py = Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.stroke();

      ctx.fillStyle = flashOn ? '#fff' : '#0a0a12';
      ctx.beginPath(); ctx.arc(0, 0, boss.hitRadius * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = coreColor; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
    }

    // パーティクル（爆発の破片）
    for (const pt of st.particles) {
      const a = pt.life / pt.maxLife;
      ctx.fillStyle = hexToRgba(pt.color, a);
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2); ctx.fill();
    }

    // 演出テキスト
    ctx.save();
    ctx.textAlign = 'center';
    if (t < CLEAR_SEQ.freeze) {
      const a = Math.min(1, t / 20);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ff2d55';
      ctx.font = '700 20px "JetBrains Mono", monospace';
      ctx.fillText('侵蝕完了', W / 2, H * 0.62);
    } else if (t < CLEAR_SEQ.shake) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 22px "JetBrains Mono", monospace';
      ctx.fillText('崩壊が始まる', W / 2, H * 0.62);
    } else if (t < CLEAR_SEQ.burst) {
      const a = clamp((CLEAR_SEQ.burst - t) / 40, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 26px serif';
      ctx.fillText('監視者、消滅', W / 2, H * 0.62);
    } else {
      const a = clamp(1 - (t - CLEAR_SEQ.burst) / (CLEAR_SEQ.fade - CLEAR_SEQ.burst), 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#d4af37';
      ctx.font = '800 30px serif';
      ctx.fillText('討伐完了', W / 2, H * 0.5);
    }
    ctx.restore();

    // フェード終盤は画面全体を黒に沈める
    if (t >= CLEAR_SEQ.burst) {
      const fadeA = clamp((t - CLEAR_SEQ.burst) / (CLEAR_SEQ.fade - CLEAR_SEQ.burst), 0, 1);
      ctx.fillStyle = `rgba(0,0,0,${fadeA * 0.85})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ---------------- メインループ ---------------- */
  function loop() {
    const st = stateRef.current;
    if (!st || !st.running) return;

    if (st.cleared) {
      // 撃破演出フェーズ：通常の弾幕更新は止め、演出だけを進める
      st.survivalFrames++;
      updateClearSequence(st);
      updateParticles(st);
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx) drawClearSequence(ctx, st);
      if (!st.clearSeqDone) {
        rafRef.current = requestAnimationFrame(loop);
      }
      return;
    }

    // デバッグモードの再生速度調整（無効時は常に1ステップ=通常速度のまま）
    const dbg = debugRef.current;
    let steps = 1;
    if (dbg.enabled && dbg.speedMul !== 1) {
      if (dbg.speedMul > 1) {
        steps = Math.round(dbg.speedMul);
      } else {
        st._slowAccum = (st._slowAccum || 0) + dbg.speedMul;
        steps = 0;
        if (st._slowAccum >= 1) { st._slowAccum -= 1; steps = 1; }
      }
    }
    for (let i = 0; i < steps; i++) {
      st.survivalFrames++;
      updatePlayer(st);
      updateBoss(st);
      updateLevel(st);
      updateBullets(st);
      updateParticles(st);
      if (st.cleared || !st.running) break;
    }

    if (centerMsgTimerRef.current > 0) {
      centerMsgTimerRef.current--;
      if (centerMsgTimerRef.current === 0) setCenterMsg(c => ({ ...c, show: false }));
    }

    // HUD更新（頻度を落として負荷軽減：3フレームに1回）
    if (st.survivalFrames % 3 === 0) {
      setHudLevel(st.level);
      setHudTime(st.survivalFrames / 60);
      setHudGraze(st.grazeCount);
    }

    if (dbg.enabled) {
      const perf = perfRef.current;
      perf.frames++;
      const now = performance.now();
      if (now - perf.lastT >= 500) {
        const fps = perf.lastT ? (perf.frames * 1000) / (now - perf.lastT) : 0;
        perf.lastT = now;
        perf.frames = 0;
        setDebugStats({ fps: Math.round(fps), bullets: st.bullets.length, lasers: st.lasers.length, particles: st.particles.length });
      }
    }

    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) draw(ctx, st);

    rafRef.current = requestAnimationFrame(loop);
  }

  /* ---------------- ラン開始・終了 ---------------- */
  function startRun(startLevel, opts) {
    // 通常プレイの起動経路では常にデバッグ状態をリセットする（管理者パネル経由のみ有効化される）
    const debugOpts = opts && opts.debug;
    debugRef.current = debugOpts
      ? { enabled: true, godMode: !!debugOpts.godMode, speedMul: debugOpts.speedMul || 1 }
      : { enabled: false, godMode: false, speedMul: 1 };

    const st = freshState();
    if (startLevel && startLevel > 1) {
      st.level = Math.min(CLEAR_LEVEL, Math.max(1, Math.floor(startLevel)));
    }
    st.running = true;
    stateRef.current = st;
    setHudLevel(st.level); setHudTime(0); setHudLives(3); setHudGraze(0);
    setCenterMsg({ text: '', show: false });
    setResult(null);
    setIsClearSeq(false);
    skipHomeBgmRef.current = true; // 直後にscreenが変わってeffectのクリーンアップが走っても、BGMを止めない
    setScreen('playing');
    triggerCenterMsg(`LEVEL ${st.level}`, '#c41e3a');
    stopDrone();   // ホーム画面用BGMのノード参照をクリアしてから、レイド戦用BGMを新規に開始する
    startDrone(st.level);
    rafRef.current = requestAnimationFrame(loop);
  }

  function finishRun(st, cleared = false) {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const secs = st.survivalFrames / 60;
    const finalLevel = cleared ? CLEAR_LEVEL : st.level;
    const res = { level: finalLevel, time: secs, graze: st.grazeCount, cleared };
    setResult(res);
    setShareImgUrl(null);
    setLocalStats(s => {
      const historyEntry = { level: finalLevel, time: Number(secs.toFixed(2)), graze: st.grazeCount, cleared, ts: Date.now() };
      const history = [historyEntry, ...s.history].slice(0, 200); // 直近200件まで保持
      return {
        attempts: s.attempts + 1,
        bestLevel: Math.max(s.bestLevel, finalLevel),
        bestTime: Math.max(s.bestTime, secs),
        cleared: s.cleared || cleared,
        history
      };
    });
    setScreen('result');
  }

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); stopDrone(); };
  }, []);

  // 画面遷移に応じたBGM制御：プレイ中(playing)以外の画面では、
  // 落ち着いたLv1相当のドローンをホームBGMとして流す。プレイ中はstartRun/updateBgmTierが制御する。
  // skipHomeBgmRef: これから'playing'へ遷移する場合に立てるフラグ。
  // このeffectの「クリーンアップ」と「本体」の両方がこれを見て、プレイ開始時にBGMを誤って止めないようにする。
  const skipHomeBgmRef = useRef(false);
  useEffect(() => {
    if (muted) return;
    if (screen === 'playing') return; // プレイ中はstartRun側で既にドローンが鳴っている
    startDrone(1, true); // ホーム画面用アンビエントBGM
    return () => {
      if (skipHomeBgmRef.current) {
        // これから'playing'に遷移するところなので、ここでは止めない(startRun側がBGMを引き継ぐ)
        skipHomeBgmRef.current = false;
        return;
      }
      stopDrone();
    };
  }, [screen, muted]);

  // 起動時：この端末に保存されたプレイヤーデータを読み込む(個人用・非共有)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('aw_playerData');
      if (raw) {
        const parsed = JSON.parse(raw);
        setLocalStats(s => ({
          attempts: parsed.attempts || 0,
          bestLevel: parsed.bestLevel || 0,
          bestTime: parsed.bestTime || 0,
          cleared: !!parsed.cleared,
          history: Array.isArray(parsed.history) ? parsed.history : []
        }));
      }
    } catch (_) { /* 初回起動など、データがなければ何もしない */ }
    localStatsLoadedRef.current = true;
  }, []);

  // localStatsが変化するたびに端末へ保存(読み込み完了後のみ、初期状態での上書きを防ぐ)
  useEffect(() => {
    if (!localStatsLoadedRef.current) return;
    try { localStorage.setItem('aw_playerData', JSON.stringify(localStats)); } catch (_) { /* 保存失敗は致命的でないため無視 */ }
  }, [localStats]);

  /* ---------------- 入力ハンドラ ---------------- */
  const getCoords = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: W / 2, y: H / 2 };
    const rect = canvas.getBoundingClientRect();
    return { x: (clientX - rect.left) * (W / rect.width), y: (clientY - rect.top) * (H / rect.height) };
  }, []);

  const onMouseMove = (e) => {
    const p = getCoords(e.clientX, e.clientY);
    inputRef.current.x = p.x; inputRef.current.y = p.y;
  };
  const onMouseDown = (e) => { if (e.button === 2) inputRef.current.slow = true; };
  const onMouseUp = (e) => { if (e.button === 2) inputRef.current.slow = false; };
  const onContextMenu = (e) => e.preventDefault();

  useEffect(() => {
    const kd = (e) => { if (e.key === 'Shift') inputRef.current.slow = true; };
    const ku = (e) => { if (e.key === 'Shift') inputRef.current.slow = false; };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, []);

  const onTouchStart = (e) => {
    e.preventDefault();
    const t = e.touches[0];
    const p = getCoords(t.clientX, t.clientY);
    inputRef.current.isTouch = true;
    inputRef.current.slow = true; // タッチ操作中は常に低速・精密モード
    inputRef.current.x = p.x; inputRef.current.y = clamp(p.y - TOUCH_Y_OFFSET, 12, H - 12);
  };
  const onTouchMove = (e) => {
    e.preventDefault();
    const t = e.touches[0];
    const p = getCoords(t.clientX, t.clientY);
    inputRef.current.x = p.x; inputRef.current.y = clamp(p.y - TOUCH_Y_OFFSET, 12, H - 12);
  };
  const onTouchEnd = (e) => {
    e.preventDefault();
    inputRef.current.slow = false;
  };

  /* ---------------- ランキング（グローバル共有ストレージ） ---------------- */
  const [rankingScope, setRankingScope] = useState('all'); // all | weekly
  const rankingCacheRef = useRef([]); // 全件キャッシュ（絞り込みの再計算用）
  const [globalStats, setGlobalStats] = useState(null); // 累計挑戦者数・到達レベル帯分布(全期間・全プレイヤー)

  const loadRanking = useCallback(async (scope) => {
    setRankingLoading(true);
    try {
      // クリア済み優先・タイム/レベルでの厳密な並びはクライアント側(applyRankingScope)で行うため、
      // ここでは直近の送信順に十分な件数を取得するだけでよい。
      const q = query(collection(db, 'scores'), orderBy('ts', 'desc'), limit(500));
      const snap = await getDocs(q);
      const entries = snap.docs.map(d => d.data());
      rankingCacheRef.current = entries;
      applyRankingScope(scope || rankingScope, entries);
      setGlobalStats(computeGlobalStats(entries)); // 全期間・全レコードを対象に集計(週間フィルタは適用しない)
    } catch (e) {
      rankingCacheRef.current = [];
      setRanking([]);
      setGlobalStats(null);
    }
    setRankingLoading(false);
  }, [rankingScope]);

  function applyRankingScope(scope, entries) {
    const now = Date.now();
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    let filtered = entries;
    if (scope === 'weekly') {
      filtered = entries.filter(e => e.ts && (now - e.ts) <= WEEK_MS);
    }
    const sorted = [...filtered].sort((a, b) => {
      const ac = Number(!!a.cleared), bc = Number(!!b.cleared);
      if (ac !== bc) return bc - ac; // クリア済みを先頭に
      if (ac === 1) return a.time - b.time; // クリア済み同士は早い討伐タイムが上位
      return (b.level - a.level) || (b.time - a.time); // 未クリアはレベル→時間で比較
    });
    setRanking(sorted.slice(0, 50));
  }

  // 全プレイヤー横断の統計：累計挑戦者数(送信済みレコード数)と、到達レベル帯分布(クリア済みも含む)
  function computeGlobalStats(entries) {
    if (!entries || entries.length === 0) return null;
    const bandCounts = TITLES.map(band => ({ band, count: 0 }));
    entries.forEach(e => {
      const lv = e.level || 0;
      const idx = bandCounts.findIndex(b => lv >= b.band.min && lv <= b.band.max);
      if (idx >= 0) bandCounts[idx].count++;
    });
    const maxBandCount = Math.max(1, ...bandCounts.map(b => b.count));
    const clearCount = entries.filter(e => e.cleared).length;
    return {
      totalChallengers: entries.length,
      clearCount,
      clearRate: (clearCount / entries.length) * 100,
      bandCounts,
      maxBandCount
    };
  }

  function switchRankingScope(scope) {
    setRankingScope(scope);
    applyRankingScope(scope, rankingCacheRef.current);
  }

  // 送信試行の可否は都度のリトライ結果で判断する（起動時の一度きりの判定はモバイル回線の
  // 一時的な不調を恒久的な機能不全と誤判定しやすいため使わない）

  async function submitScore() {
    if (!result) return;
    const name = (playerName.trim() || '名無しの挑戦者').slice(0, 16);

    setSubmitState('submitting');
    setSubmitErrorMsg('');

    const entry = { name, level: result.level, time: Number(result.time.toFixed(2)), graze: result.graze, cleared: !!result.cleared, ts: Date.now() };

    // モバイル回線など不安定な通信環境を想定し、間隔を空けながら複数回試行する
    const RETRY_DELAYS_MS = [0, 800, 2000]; // 即時 → 0.8秒後 → 2秒後
    let lastError = null;

    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      if (RETRY_DELAYS_MS[i] > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[i]));
      try {
        await addDoc(collection(db, 'scores'), entry);
        setSubmitState('done');
        loadRanking(rankingScope);
        return;
      } catch (e) {
        lastError = e;
      }
    }

    // 全リトライが失敗：通信環境が原因の可能性を案内しつつ、この端末にだけ記録を残す
    try {
      const localKey = 'aw_local_fallback_scores';
      const existing = JSON.parse(localStorage.getItem(localKey) || '[]');
      existing.push(entry);
      localStorage.setItem(localKey, JSON.stringify(existing));
      setSubmitState('localFallback');
      return;
    } catch (_) { /* 個人保存も失敗した場合は下のunavailable表示に委ねる */ }

    setSubmitState('unavailable');
    setSubmitErrorMsg((lastError && lastError.message) ? lastError.message : String(lastError));
  }

  function openRanking() {
    setScreen('ranking');
    loadRanking(rankingScope);
  }

  /* ---------------- 討伐者殿堂（クリア者専用一覧） ---------------- */
  const [hallOfFame, setHallOfFame] = useState([]);
  const [hallLoading, setHallLoading] = useState(false);

  const loadHallOfFame = useCallback(async () => {
    setHallLoading(true);
    try {
      const q = query(collection(db, 'scores'), orderBy('ts', 'desc'), limit(500));
      const snap = await getDocs(q);
      const entries = snap.docs.map(d => d.data()).filter(e => e.cleared);
      setHallOfFame(entries.slice(0, 100));
    } catch (e) {
      setHallOfFame([]);
    }
    setHallLoading(false);
  }, []);

  function openHallOfFame() {
    setScreen('hallOfFame');
    loadHallOfFame();
  }

  function formatClearDate(ts) {
    if (!ts) return '--';
    const d = new Date(ts);
    const now = Date.now();
    const diffMs = now - ts;
    const diffMin = diffMs / 60000;
    if (diffMin < 60) return `${Math.max(1, Math.floor(diffMin))}分前`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}時間前`;
    if (diffMin < 1440 * 30) return `${Math.floor(diffMin / 1440)}日前`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  /* ---------------- プレイヤーデータ画面（この端末のローカル記録） ---------------- */
  function openPlayerData() {
    setScreen('playerData');
  }

  // 詳細分析：レベル帯別の死亡回数分布・平均値などをhistoryから算出
  function computePlayerAnalysis(history) {
    if (!history || history.length === 0) return null;

    const deaths = history.filter(h => !h.cleared);
    const clears = history.filter(h => h.cleared);

    // レベル帯別の死亡回数分布（称号帯と同じ区切りを流用）
    const bandCounts = TITLES.map(band => ({ band, count: 0 }));
    deaths.forEach(h => {
      const idx = bandCounts.findIndex(b => h.level >= b.band.min && h.level <= b.band.max);
      if (idx >= 0) bandCounts[idx].count++;
    });
    const maxBandCount = Math.max(1, ...bandCounts.map(b => b.count));

    const avgGraze = history.reduce((sum, h) => sum + (h.graze || 0), 0) / history.length;
    const avgTime = history.reduce((sum, h) => sum + (h.time || 0), 0) / history.length;
    const avgLevel = history.reduce((sum, h) => sum + (h.level || 0), 0) / history.length;
    const clearRate = history.length > 0 ? (clears.length / history.length) * 100 : 0;

    // 最も多く死んでいるレベル帯（死亡数が1件以上ある場合のみ）
    const worstBand = bandCounts.reduce((worst, b) => (b.count > (worst?.count || 0) ? b : worst), null);

    return { bandCounts, maxBandCount, avgGraze, avgTime, avgLevel, clearRate, deathCount: deaths.length, clearCount: clears.length, worstBand };
  }

  /* ---------------- シェア画像生成 ---------------- */
  const [shareImgUrl, setShareImgUrl] = useState(null);
  const [shareGenerating, setShareGenerating] = useState(false);
  function generateShareImage() {
    if (!result) return;
    setShareGenerating(true);
    const cw = 800, ch = 1000;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');

    // 背景
    const bgGrad = g.createRadialGradient(cw / 2, ch * 0.35, 40, cw / 2, ch * 0.35, ch * 0.8);
    bgGrad.addColorStop(0, '#150a18');
    bgGrad.addColorStop(1, '#050408');
    g.fillStyle = bgGrad;
    g.fillRect(0, 0, cw, ch);

    // 枠
    g.strokeStyle = 'rgba(212,175,55,0.4)';
    g.lineWidth = 2;
    g.strokeRect(20, 20, cw - 40, ch - 40);

    const title = titleForLevel(result.level);

    g.textAlign = 'center';
    g.fillStyle = '#c41e3a';
    g.font = '600 22px "JetBrains Mono", monospace';
    g.fillText('ABYSSAL DUEL RAID — ENDLESS', cw / 2, 110);

    g.fillStyle = '#e8e6f0';
    g.font = '800 64px serif';
    g.fillText('深淵絶界', cw / 2, 190);

    // レベル大表示
    g.fillStyle = '#d4af37';
    g.font = '700 140px "JetBrains Mono", monospace';
    g.fillText(`Lv.${result.level}`, cw / 2, 380);

    // 称号
    g.fillStyle = title.color;
    g.font = '700 34px serif';
    g.fillText(`「${title.name}」`, cw / 2, 440);

    // 統計
    g.font = '500 24px "JetBrains Mono", monospace';
    g.fillStyle = '#6a6780';
    const statY = 560;
    g.fillText('生存時間', cw / 2 - 200, statY);
    g.fillText('グレイズ', cw / 2 + 200, statY);
    g.fillStyle = '#4a9eff';
    g.font = '700 40px "JetBrains Mono", monospace';
    g.fillText(`${result.time.toFixed(2)}s`, cw / 2 - 200, statY + 50);
    g.fillStyle = '#b967ff';
    g.fillText(`${result.graze}`, cw / 2 + 200, statY + 50);

    // フッター
    g.fillStyle = '#6a6780';
    g.font = '400 18px "JetBrains Mono", monospace';
    g.fillText('ABYSSAL WATCHER · INFINITE ASCENT', cw / 2, ch - 60);

    c.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        setShareImgUrl(url);
      }
      setShareGenerating(false);
    });
  }

  function downloadShareImage() {
    if (!shareImgUrl) return;
    const a = document.createElement('a');
    a.href = shareImgUrl;
    a.download = `abyssal-watcher-lv${result.level}.png`;
    a.click();
  }

  /* ---------------- 描画（React部） ---------------- */
  const diffLabel = (lvl) => {
    if (lvl < 6) return '侵入';
    if (lvl < 13) return '警戒';
    if (lvl < 21) return '狂乱';
    if (lvl < 29) return '深淵';
    if (lvl < 37) return '虚無';
    if (lvl < 45) return '残響';
    if (lvl < 53) return '不在';
    if (lvl < 60) return '最果て';
    return '討伐';
  };

  return (
    <div style={styles.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;600;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        .aw-btn {
          font-family: 'Shippori Mincho', serif; font-weight: 600; font-size: 1rem; letter-spacing: 0.1em;
          background: linear-gradient(180deg, rgba(196,30,58,0.15), rgba(196,30,58,0.05));
          border: 1px solid #c41e3a; color: #e8e6f0; padding: 14px 40px; cursor: pointer;
          clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
          transition: all 0.2s ease;
        }
        .aw-btn:hover { background: linear-gradient(180deg, rgba(196,30,58,0.35), rgba(196,30,58,0.1)); box-shadow: 0 0 25px rgba(196,30,58,0.4); }
        .aw-btn.gold { border-color: #d4af37; background: linear-gradient(180deg, rgba(212,175,55,0.15), rgba(212,175,55,0.04)); }
        .aw-btn.gold:hover { background: linear-gradient(180deg, rgba(212,175,55,0.3), rgba(212,175,55,0.08)); box-shadow: 0 0 25px rgba(212,175,55,0.4); }
        .aw-btn-sm {
          font-family: 'JetBrains Mono', monospace; font-weight: 500; font-size: 0.72rem; letter-spacing: 0.05em;
          background: rgba(255,255,255,0.03); border: 1px solid rgba(212,175,55,0.25); color: #a8a5b8;
          padding: 9px 14px; cursor: pointer; white-space: nowrap; transition: all 0.2s ease;
        }
        .aw-btn-sm:hover { background: rgba(212,175,55,0.1); color: #e8e6f0; border-color: rgba(212,175,55,0.5); }
        .aw-btn-sm-accent { border-color: #d4af37; color: #d4af37; }
        .aw-btn-sm-accent:hover { background: rgba(212,175,55,0.15); color: #ffffff; }
        .aw-input {
          font-family: 'JetBrains Mono', monospace; background: rgba(255,255,255,0.04); border: 1px solid rgba(212,175,55,0.4);
          color: #e8e6f0; padding: 10px 14px; font-size: 13px; letter-spacing: 0.05em; text-align: center; width: 220px;
        }
        .aw-input:focus { outline: none; border-color: #d4af37; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: rgba(212,175,55,0.3); }

        @keyframes clearFadeUp {
          from { opacity: 0; transform: translateY(14px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes clearGlow {
          0%, 100% { text-shadow: 0 0 40px rgba(255,255,255,0.6), 0 0 80px rgba(212,175,55,0.4); }
          50%      { text-shadow: 0 0 60px rgba(255,255,255,0.9), 0 0 110px rgba(212,175,55,0.6); }
        }
        @keyframes titlePulse {
          0%, 100% { opacity: 0.85; }
          50%      { opacity: 1; }
        }
        .clear-eyebrow  { animation: clearFadeUp 0.5s ease-out both; }
        .clear-badge    { animation: clearFadeUp 0.6s ease-out 0.15s both, clearGlow 2.2s ease-in-out 0.8s infinite; }
        .clear-titlerow { animation: clearFadeUp 0.6s ease-out 0.35s both, titlePulse 2.4s ease-in-out 1s infinite; }
        .clear-subtitle { animation: clearFadeUp 0.6s ease-out 0.5s both; }
        .clear-lore     { animation: clearFadeUp 0.6s ease-out 0.68s both; }
        .clear-stats    { animation: clearFadeUp 0.6s ease-out 0.85s both; }
      `}</style>

      <div style={styles.canvasWrap}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          style={styles.canvas}
          onMouseMove={onMouseMove}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onContextMenu={onContextMenu}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        />

        {screen === 'playing' && (
          <div style={styles.hud}>
            {!isClearSeq && (
              <>
                <div style={styles.hudTop}>
                  <div style={styles.levelRow}>
                    <span style={styles.levelName}>深淵の監視者</span>
                    <span style={styles.levelTag}>Lv.{hudLevel}/{CLEAR_LEVEL} 「{diffLabel(hudLevel)}」</span>
                  </div>
                  <div style={styles.grazeText}>GRAZE: {hudGraze}</div>
                </div>
                <div style={styles.hudBottom}>
                  <div style={styles.livesRow}>
                    {[0, 1, 2].map(i => (
                      <div key={i} style={{ ...styles.lifeDot, ...(i >= hudLives ? styles.lifeDotLost : {}) }} />
                    ))}
                  </div>
                  <div style={styles.infoBlock}>
                    <div>TIME <b style={{ color: '#4a9eff' }}>{hudTime.toFixed(2).padStart(5, '0')}</b></div>
                  </div>
                </div>
              </>
            )}
            <div style={styles.volumeWrap}>
              <button onClick={() => setVolumeOpen(o => !o)} style={styles.muteBtn}>
                {muted || volume === 0 ? '🔇' : '🔊'}
              </button>
              {volumeOpen && (
                <div style={styles.volumePopover}>
                  <input
                    type="range" min={0} max={100} value={Math.round(volume * 100)}
                    onChange={e => changeVolume(Number(e.target.value) / 100)}
                    style={styles.volumeSlider}
                  />
                  <span style={styles.volumeValue}>{Math.round(volume * 100)}</span>
                </div>
              )}
            </div>
            {centerMsg.show && (
              <div style={{ ...styles.centerMsg, color: centerMsg.color }}>{centerMsg.text}</div>
            )}
            {debugRef.current.enabled && (
              <div style={styles.debugOverlay}>
                DEBUG MODE<br />
                FPS {debugStats.fps}　LV {hudLevel}<br />
                BULLETS {debugStats.bullets}　LASERS {debugStats.lasers}　PARTICLES {debugStats.particles}<br />
                GOD MODE: {debugRef.current.godMode ? 'ON' : 'OFF'}　SPEED: {debugRef.current.speedMul}x
              </div>
            )}
          </div>
        )}

        {/* ---------------- TITLE ---------------- */}
        {screen === 'title' && (
          <div style={styles.screen}>
            <div style={styles.volumeWrap}>
              <button onClick={() => setVolumeOpen(o => !o)} style={{ ...styles.muteBtn, pointerEvents: 'auto' }}>
                {muted || volume === 0 ? '🔇' : '🔊'}
              </button>
              {volumeOpen && (
                <div style={{ ...styles.volumePopover, pointerEvents: 'auto' }}>
                  <input
                    type="range" min={0} max={100} value={Math.round(volume * 100)}
                    onChange={e => changeVolume(Number(e.target.value) / 100)}
                    style={styles.volumeSlider}
                  />
                  <span style={styles.volumeValue}>{Math.round(volume * 100)}</span>
                </div>
              )}
            </div>
            <div style={styles.eyebrow}>ABYSSAL DUEL RAID</div>
            <h1 style={styles.title}>深淵絶界</h1>
            <div style={styles.subtitle}>-- ABYSSAL WATCHER --</div>
            <p style={styles.lore}>
              15秒ごとにレベルが上がり、弾幕は際限なく苛烈になる。<br />
              Lv.{CLEAR_LEVEL}の監視者を打ち破った者だけが、討伐者を名乗れる。<br />
              ライフは3。記録は全世界の挑戦者と競う。
            </p>
            <div style={styles.statRow}>
              <div style={styles.stat}><span style={styles.statNum}>{localStats.attempts}</span><span style={styles.statLbl}>総挑戦回数</span></div>
              <div style={styles.stat}><span style={styles.statNum}>{localStats.bestLevel > 0 ? `Lv.${localStats.bestLevel}` : '--'}</span><span style={styles.statLbl}>自己最高レベル</span></div>
              <div style={styles.stat}><span style={styles.statNum}>{localStats.bestTime > 0 ? localStats.bestTime.toFixed(1) + 's' : '--'}</span><span style={styles.statLbl}>最長生存</span></div>
            </div>
            {localStats.cleared && (
              <div style={{ fontSize: 13, color: '#ffffff', marginBottom: 8, letterSpacing: '0.1em', textShadow: '0 0 12px rgba(255,255,255,0.5)' }}>
                ★ 深淵絶界 討伐済み ★
              </div>
            )}
            {localStats.bestLevel > 0 && (
              <div style={{ fontSize: 12, color: titleForLevel(localStats.bestLevel).color, marginBottom: 18, letterSpacing: '0.06em' }}>
                現在の称号：「{titleForLevel(localStats.bestLevel).name}」
              </div>
            )}
            <div style={styles.mainActionRow}>
              <button className="aw-btn gold" onClick={() => startRun()}>挑戦を開始する</button>
            </div>
            <div style={styles.subActionRow}>
              <button className="aw-btn-sm" onClick={openRanking}>ランキング</button>
              <button className="aw-btn-sm" onClick={openPlayerData}>プレイヤーデータ</button>
              <button className="aw-btn-sm" onClick={() => setScreen('howto')}>操作方法</button>
            </div>
            <span style={styles.adminLink} onClick={() => setScreen(adminUser ? 'admin' : 'adminLogin')}>admin</span>
          </div>
        )}

        {/* ---------------- HOWTO ---------------- */}
        {screen === 'howto' && (
          <div style={styles.screen}>
            <div style={styles.eyebrow}>INSTRUCTIONS</div>
            <h1 style={{ ...styles.title, fontSize: '1.8rem' }}>操作方法</h1>
            <p style={{ ...styles.lore, textAlign: 'left', maxWidth: 420 }}>
              ▸ PC : マウス移動で自機を操作<br />
              ▸ 右クリック長押し or Shiftキーで低速精密回避モード<br />
              ▸ スマホ : 画面をドラッグして自機を操作(自動で精密モード)<br />
              ▸ 弾に触れるとライフを1失う。ライフ0で終了<br />
              ▸ 自機中央の小さな点だけが当たり判定<br />
              ▸ 15秒生存するごとにレベルが上がり、弾幕が強化される<br />
              ▸ Lv.{CLEAR_LEVEL}を耐えきれば討伐＝クリア。到達できるのはごく一部<br />
              ▸ 弾スレスレの「グレイズ」でスコアが伸びる<br />
              ▸ 赤い点滅線はレーザーの予告。隙間だけが安全地帯<br />
              ▸ 高レベルではボスが突進・瞬間移動してくる<br />
              ▸ 到達レベルに応じて称号が贈られる
            </p>
            <button className="aw-btn gold" onClick={() => setScreen('title')}>戻る</button>
          </div>
        )}

        {/* ---------------- RESULT ---------------- */}
        {screen === 'result' && result && (
          <div style={{ ...styles.screen, overflowY: 'auto', paddingTop: 40, paddingBottom: 40, justifyContent: 'flex-start' }}>
            {result.cleared ? (
              <>
                <div className="clear-eyebrow" style={{ ...styles.eyebrow, color: '#ffffff' }}>RAID CLEARED</div>
                <div className="clear-badge" style={{ ...styles.rankBadge, color: '#ffffff', marginBottom: 4 }}>
                  討伐完了
                </div>
                <div className="clear-titlerow" style={{ fontSize: 15, fontWeight: 700, color: titleForLevel(result.level).color, letterSpacing: '0.08em', marginBottom: 6 }}>
                  「{titleForLevel(result.level).name}」
                </div>
                <h1 className="clear-subtitle" style={{ ...styles.title, fontSize: '1.2rem', marginBottom: 10 }}>深淵の監視者は、沈黙した</h1>
                <p className="clear-lore" style={{ ...styles.lore, marginBottom: 18, maxWidth: 420 }}>
                  Lv.{CLEAR_LEVEL}に至るまで、幾度となく散り、幾度となく起き上がった果てに――<br />
                  監視者はついに動きを止めた。この結果に辿り着けるのは、挑戦者のごく一部に過ぎない。
                </p>
              </>
            ) : (
              <>
                <div style={styles.eyebrow}>DEFEATED</div>
                <div style={{ ...styles.rankBadge, color: '#c41e3a', textShadow: '0 0 25px rgba(196,30,58,0.5)', marginBottom: 4 }}>
                  Lv.{result.level}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: titleForLevel(result.level).color, letterSpacing: '0.08em', marginBottom: 6 }}>
                  「{titleForLevel(result.level).name}」
                </div>
                <h1 style={{ ...styles.title, fontSize: '1.2rem', marginBottom: 10 }}>{diffLabel(result.level)}の層にて力尽きた</h1>
              </>
            )}

            <div className={result.cleared ? 'clear-stats' : ''} style={{ ...styles.statRow, marginBottom: 22 }}>
              <div style={styles.stat}><span style={styles.statNum}>{result.time.toFixed(2)}s</span><span style={styles.statLbl}>生存時間</span></div>
              <div style={styles.stat}><span style={styles.statNum}>Lv.{result.level}{result.cleared ? '/' + CLEAR_LEVEL : ''}</span><span style={styles.statLbl}>到達レベル</span></div>
              <div style={styles.stat}><span style={styles.statNum}>{result.graze}</span><span style={styles.statLbl}>グレイズ</span></div>
            </div>

            {/* ランキング送信ブロック */}
            {submitState === 'done' ? (
              <div style={styles.resultBlock}>
                <div style={styles.resultBlockLabel}>ランキングに記録済み</div>
                <p style={{ fontSize: 12, color: '#6a6780', marginBottom: 12 }}>世界中の挑戦者と並んでいる。</p>
                {shareImgUrl ? (
                  <div style={{ textAlign: 'center' }}>
                    <img src={shareImgUrl} alt="結果カード" style={{ width: 160, border: '1px solid rgba(212,175,55,0.3)', display: 'block', margin: '0 auto 10px' }} />
                    <button className="aw-btn" onClick={downloadShareImage}>画像を保存</button>
                  </div>
                ) : (
                  <button className="aw-btn" onClick={generateShareImage} disabled={shareGenerating}>
                    {shareGenerating ? '生成中…' : '結果をカード画像にする'}
                  </button>
                )}
              </div>
            ) : submitState === 'localFallback' ? (
              <div style={styles.resultBlock}>
                <div style={{ ...styles.resultBlockLabel, color: '#ff8844' }}>グローバル送信は失敗</div>
                <p style={{ fontSize: 12, color: '#6a6780', marginBottom: 12, lineHeight: 1.6 }}>
                  全プレイヤー共有のランキングには載せられなかったが、この端末には記録を残せた。<br />
                  「プレイヤーデータ」から自分の記録は確認できる。
                </p>
                {shareImgUrl ? (
                  <div style={{ textAlign: 'center' }}>
                    <img src={shareImgUrl} alt="結果カード" style={{ width: 160, border: '1px solid rgba(212,175,55,0.3)', display: 'block', margin: '0 auto 10px' }} />
                    <button className="aw-btn" onClick={downloadShareImage}>画像を保存</button>
                  </div>
                ) : (
                  <button className="aw-btn" onClick={generateShareImage} disabled={shareGenerating}>
                    {shareGenerating ? '生成中…' : '結果をカード画像にする'}
                  </button>
                )}
              </div>
            ) : (
              <div style={styles.resultBlock}>
                <div style={styles.resultBlockLabel}>ランキングに記録する</div>
                <input
                  className="aw-input"
                  placeholder="名前を入力(全世界に表示)"
                  value={playerName}
                  onChange={e => setPlayerName(e.target.value)}
                  maxLength={16}
                  style={{ marginBottom: 12 }}
                />
                <button className="aw-btn gold" onClick={submitScore} disabled={submitState === 'submitting'} style={{ width: '100%', maxWidth: 260 }}>
                  {submitState === 'submitting' ? '送信中…(通信を再試行しています)' : '記録を送信する'}
                </button>
                {submitState === 'unavailable' && (
                  <p style={{ fontSize: 11, color: '#c41e3a', marginTop: 10, marginBottom: 0, lineHeight: 1.6 }}>
                    送信に失敗した（複数回再試行済み）：{submitErrorMsg || '不明なエラー'}<br />
                    通信状況を確認して、もう一度試すか、そのまま先に進める。
                  </p>
                )}
              </div>
            )}

            {/* 主要アクション：常に同じ位置に固定表示 */}
            <div style={{ ...styles.btnRow, marginTop: 22 }}>
              <button className="aw-btn gold" onClick={() => startRun()}>再挑戦する</button>
              {submitState === 'done' && <button className="aw-btn" onClick={openRanking}>ランキングを見る</button>}
              <button className="aw-btn" onClick={() => setScreen('title')}>ホームへ戻る</button>
            </div>
          </div>
        )}

        {/* ---------------- RANKING ---------------- */}
        {screen === 'ranking' && (
          <div style={styles.screen}>
            <div style={styles.eyebrow}>GLOBAL RANKING</div>
            <h1 style={{ ...styles.title, fontSize: '1.7rem' }}>ランキング</h1>
            <p style={{ ...styles.subtitle, marginBottom: 14 }}>全プレイヤー共有の記録です</p>

            <div style={styles.scopeTabs}>
              <button
                className="aw-btn"
                style={rankingScope === 'all' ? styles.scopeTabActive : styles.scopeTabInactive}
                onClick={() => switchRankingScope('all')}
              >全期間</button>
              <button
                className="aw-btn"
                style={rankingScope === 'weekly' ? styles.scopeTabActive : styles.scopeTabInactive}
                onClick={() => switchRankingScope('weekly')}
              >週間</button>
            </div>

            {globalStats && (
              <>
                <div style={styles.pdAnalysisGrid3}>
                  <div style={styles.pdAnalysisCard}>
                    <span style={styles.pdAnalysisNum}>{globalStats.totalChallengers}</span>
                    <span style={styles.pdAnalysisLbl}>累計挑戦者数</span>
                  </div>
                  <div style={styles.pdAnalysisCard}>
                    <span style={styles.pdAnalysisNum}>{globalStats.clearCount}</span>
                    <span style={styles.pdAnalysisLbl}>討伐達成数</span>
                  </div>
                  <div style={styles.pdAnalysisCard}>
                    <span style={styles.pdAnalysisNum}>{globalStats.clearRate.toFixed(1)}%</span>
                    <span style={styles.pdAnalysisLbl}>討伐率</span>
                  </div>
                </div>

                <div style={{ fontSize: 11, color: '#6a6780', marginBottom: 8, fontFamily: "'JetBrains Mono', monospace", alignSelf: 'flex-start' }}>
                  到達レベル帯分布（全プレイヤー・クリア済み含む）
                </div>
                <div style={styles.pdBandChart}>
                  {globalStats.bandCounts.map((b, i) => (
                    <div key={i} style={styles.pdBandRow}>
                      <span style={styles.pdBandLabel}>Lv.{b.band.min}台</span>
                      <div style={styles.pdBandBarTrack}>
                        <div style={{
                          ...styles.pdBandBarFill,
                          width: `${(b.count / globalStats.maxBandCount) * 100}%`,
                          background: '#d4af37',
                          opacity: b.count > 0 ? 0.85 : 0.15
                        }} />
                      </div>
                      <span style={styles.pdBandCount}>{b.count}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={styles.rankListWrap}>
              {rankingLoading ? (
                <div style={styles.rankEmpty}>読み込み中…</div>
              ) : ranking.length === 0 ? (
                <div style={styles.rankEmpty}>まだ記録がない。最初の挑戦者になれ。</div>
              ) : (
                <div style={styles.rankList}>
                  {ranking.map((r, i) => {
                    const t = titleForLevel(r.level);
                    return (
                      <div key={i} style={{ ...styles.rankRow, ...(i < 3 ? styles.rankRowTop : {}), ...(r.cleared ? styles.rankRowCleared : {}) }}>
                        <span style={{ ...styles.rankPos, color: i === 0 ? '#d4af37' : i === 1 ? '#c9c9d4' : i === 2 ? '#c67a3d' : '#6a6780' }}>
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span style={styles.rankName}>
                          {r.cleared && <span style={{ marginRight: 4 }}>👑</span>}
                          {r.name}
                          <span style={{ display: 'block', fontSize: 9, color: t.color, opacity: 0.85 }}>{t.name}</span>
                        </span>
                        <span style={styles.rankLevel}>{r.cleared ? '討伐' : `Lv.${r.level}`}</span>
                        <span style={styles.rankTime}>{Number(r.time).toFixed(1)}s</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{ ...styles.subActionRow, marginTop: 20 }}>
              <button className="aw-btn-sm" onClick={() => loadRanking(rankingScope)}>更新</button>
              <button className="aw-btn-sm" onClick={openHallOfFame}>討伐者殿堂</button>
              <button className="aw-btn-sm aw-btn-sm-accent" onClick={() => setScreen('title')}>タイトルへ</button>
            </div>
          </div>
        )}

        {/* ---------------- HALL OF FAME (討伐者専用一覧) ---------------- */}
        {screen === 'hallOfFame' && (
          <div style={styles.screen}>
            <div style={{ ...styles.eyebrow, color: '#ffffff' }}>HALL OF FAME</div>
            <h1 style={{ ...styles.title, fontSize: '1.7rem' }}>討伐者殿堂</h1>
            <p style={{ ...styles.subtitle, marginBottom: 18 }}>
              Lv.{CLEAR_LEVEL}の深淵の監視者を打ち破った者たちの記録
            </p>

            <div style={styles.rankListWrap}>
              {hallLoading ? (
                <div style={styles.rankEmpty}>読み込み中…</div>
              ) : hallOfFame.length === 0 ? (
                <div style={styles.rankEmpty}>まだ誰も辿り着いていない。最初の討伐者になれ。</div>
              ) : (
                <div style={styles.rankList}>
                  {hallOfFame.map((r, i) => {
                    const t = titleForLevel(r.level);
                    return (
                      <div key={i} style={{ ...styles.rankRow, ...styles.rankRowCleared }}>
                        <span style={{ ...styles.rankPos, color: '#d4af37' }}>
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span style={styles.rankName}>
                          <span style={{ marginRight: 4 }}>👑</span>
                          {r.name}
                          <span style={{ display: 'block', fontSize: 9, color: t.color, opacity: 0.85 }}>{t.name}</span>
                        </span>
                        <span style={{ ...styles.rankLevel, fontSize: 10, color: '#6a6780' }}>{formatClearDate(r.ts)}</span>
                        <span style={styles.rankTime}>{Number(r.time).toFixed(1)}s</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{ ...styles.subActionRow, marginTop: 20 }}>
              <button className="aw-btn-sm" onClick={loadHallOfFame}>更新</button>
              <button className="aw-btn-sm" onClick={openRanking}>ランキングへ</button>
              <button className="aw-btn-sm aw-btn-sm-accent" onClick={() => setScreen('title')}>タイトルへ</button>
            </div>
          </div>
        )}

        {/* ---------------- PLAYER DATA (この端末のローカル記録) ---------------- */}
        {screen === 'playerData' && (
          <div style={{ ...styles.screen, justifyContent: 'flex-start', overflowY: 'auto', paddingTop: 50, paddingBottom: 90 }}>
            <div style={styles.eyebrow}>PLAYER DATA</div>
            <h1 style={{ ...styles.title, fontSize: '1.7rem' }}>プレイヤーデータ</h1>
            <p style={{ ...styles.subtitle, marginBottom: 20 }}>この端末に記録された挑戦の軌跡</p>

            {/* 基本統計 */}
            <div style={styles.statRow}>
              <div style={styles.stat}><span style={styles.statNum}>{localStats.attempts}</span><span style={styles.statLbl}>総挑戦回数</span></div>
              <div style={styles.stat}><span style={styles.statNum}>{localStats.bestLevel > 0 ? `Lv.${localStats.bestLevel}` : '--'}</span><span style={styles.statLbl}>自己最高レベル</span></div>
              <div style={styles.stat}><span style={styles.statNum}>{localStats.bestTime > 0 ? localStats.bestTime.toFixed(1) + 's' : '--'}</span><span style={styles.statLbl}>最長生存</span></div>
            </div>
            {localStats.cleared && (
              <div style={{ fontSize: 13, color: '#ffffff', marginBottom: 20, letterSpacing: '0.1em', textShadow: '0 0 12px rgba(255,255,255,0.5)' }}>
                ★ 深淵絶界 討伐済み ★
              </div>
            )}

            {(() => {
              const analysis = computePlayerAnalysis(localStats.history);
              if (!analysis) {
                return (
                  <p style={{ ...styles.lore, marginBottom: 24 }}>
                    まだ記録がない。一度挑戦すれば、ここに軌跡が刻まれていく。
                  </p>
                );
              }
              return (
                <>
                  {/* 詳細分析 */}
                  <div style={styles.pdSectionTitle}>詳細分析</div>
                  <div style={styles.pdAnalysisGrid}>
                    <div style={styles.pdAnalysisCard}>
                      <span style={styles.pdAnalysisNum}>{analysis.clearRate.toFixed(0)}%</span>
                      <span style={styles.pdAnalysisLbl}>クリア率</span>
                    </div>
                    <div style={styles.pdAnalysisCard}>
                      <span style={styles.pdAnalysisNum}>{analysis.avgLevel.toFixed(1)}</span>
                      <span style={styles.pdAnalysisLbl}>平均到達Lv</span>
                    </div>
                    <div style={styles.pdAnalysisCard}>
                      <span style={styles.pdAnalysisNum}>{analysis.avgGraze.toFixed(1)}</span>
                      <span style={styles.pdAnalysisLbl}>平均グレイズ</span>
                    </div>
                    <div style={styles.pdAnalysisCard}>
                      <span style={styles.pdAnalysisNum}>{analysis.avgTime.toFixed(1)}s</span>
                      <span style={styles.pdAnalysisLbl}>平均生存時間</span>
                    </div>
                  </div>

                  <div style={{ fontSize: 11, color: '#6a6780', marginBottom: 8, fontFamily: "'JetBrains Mono', monospace" }}>
                    レベル帯別 死亡回数分布
                    {analysis.worstBand && analysis.worstBand.count > 0 && (
                      <span style={{ color: '#ff2d55' }}>
                        {' '}・最多死亡帯: Lv.{analysis.worstBand.band.min}台 ({analysis.worstBand.count}回)
                      </span>
                    )}
                  </div>
                  <div style={styles.pdBandChart}>
                    {analysis.bandCounts.map((b, i) => (
                      <div key={i} style={styles.pdBandRow}>
                        <span style={styles.pdBandLabel}>Lv.{b.band.min}台</span>
                        <div style={styles.pdBandBarTrack}>
                          <div style={{
                            ...styles.pdBandBarFill,
                            width: `${(b.count / analysis.maxBandCount) * 100}%`,
                            background: '#4a9eff',
                            opacity: b.count > 0 ? 0.85 : 0.15
                          }} />
                        </div>
                        <span style={styles.pdBandCount}>{b.count}</span>
                      </div>
                    ))}
                  </div>

                  {/* 称号一覧 */}
                  <div style={{ ...styles.pdSectionTitle, marginTop: 26 }}>称号一覧</div>
                  <div style={styles.pdTitleGrid}>
                    {TITLES.map((t, i) => {
                      const unlocked = localStats.bestLevel >= t.min;
                      return (
                        <div key={i} style={{ ...styles.pdTitleCard, ...(unlocked ? {} : styles.pdTitleCardLocked) }}>
                          <span style={{ ...styles.pdTitleName, color: unlocked ? t.color : '#3a3844' }}>
                            {unlocked ? t.name : '？？？'}
                          </span>
                          <span style={styles.pdTitleRange}>
                            Lv.{t.min}{t.max < 9999 ? `–${t.max}` : '+'}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* プレイ履歴 */}
                  <div style={{ ...styles.pdSectionTitle, marginTop: 26 }}>プレイ履歴（直近{Math.min(localStats.history.length, 50)}件）</div>
                  <div style={styles.rankListWrap}>
                    <div style={styles.rankList}>
                      {localStats.history.slice(0, 50).map((h, i) => (
                        <div key={i} style={{ ...styles.rankRow, ...(h.cleared ? styles.rankRowCleared : {}), gridTemplateColumns: '80px 1fr 60px 50px' }}>
                          <span style={{ fontSize: 10, color: '#6a6780' }}>{formatClearDate(h.ts)}</span>
                          <span style={styles.rankName}>{h.cleared ? '👑 討伐成功' : `Lv.${h.level}で敗北`}</span>
                          <span style={styles.rankLevel}>{Number(h.time).toFixed(1)}s</span>
                          <span style={{ ...styles.rankTime, fontSize: 10 }}>gz{h.graze}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              );
            })()}

            <div style={{ ...styles.btnRow, marginTop: 24 }}>
              <button className="aw-btn gold" onClick={() => setScreen('title')}>タイトルへ</button>
            </div>
          </div>
        )}

        {/* ---------------- ADMIN LOGIN ---------------- */}
        {screen === 'adminLogin' && (
          <div style={styles.screen}>
            <div style={styles.eyebrow}>ADMIN</div>
            <h1 style={{ ...styles.title, fontSize: '1.5rem' }}>管理者ログイン</h1>
            <form onSubmit={handleAdminLogin} style={{ width: '100%', maxWidth: 280, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
              <input
                className="aw-input"
                type="email"
                placeholder="メールアドレス"
                value={adminEmail}
                onChange={e => setAdminEmail(e.target.value)}
                autoComplete="username"
              />
              <input
                className="aw-input"
                type="password"
                placeholder="パスワード"
                value={adminPassword}
                onChange={e => setAdminPassword(e.target.value)}
                autoComplete="current-password"
              />
              {adminLoginError && (
                <p style={{ fontSize: 12, color: '#c41e3a', margin: 0 }}>{adminLoginError}</p>
              )}
              <button type="submit" className="aw-btn gold" disabled={adminLoginBusy}>
                {adminLoginBusy ? 'ログイン中…' : 'ログイン'}
              </button>
            </form>
            <button className="aw-btn" style={{ marginTop: 16 }} onClick={() => setScreen('title')}>戻る</button>
          </div>
        )}

        {/* ---------------- ADMIN PANEL ---------------- */}
        {screen === 'admin' && adminUser && (
          <div style={{ ...styles.screen, justifyContent: 'flex-start', overflowY: 'auto', paddingTop: 40, paddingBottom: 60 }}>
            <div style={styles.eyebrow}>ADMIN PANEL</div>
            <h1 style={{ ...styles.title, fontSize: '1.5rem' }}>管理者パネル</h1>
            <p style={{ fontSize: 12, color: '#6a6780', marginBottom: 16 }}>{adminUser.email}</p>

            {(() => {
              const stats = computeGlobalStats(adminEntries);
              return stats ? (
                <div style={styles.statRow}>
                  <div style={styles.stat}><span style={styles.statNum}>{stats.totalChallengers}</span><span style={styles.statLbl}>総記録数</span></div>
                  <div style={styles.stat}><span style={styles.statNum}>{stats.clearCount}</span><span style={styles.statLbl}>クリア数</span></div>
                  <div style={styles.stat}><span style={styles.statNum}>{stats.clearRate.toFixed(1)}%</span><span style={styles.statLbl}>クリア率</span></div>
                </div>
              ) : (
                <p style={{ fontSize: 12, color: '#6a6780', marginBottom: 12 }}>{adminLoading ? '読み込み中…' : 'データがありません'}</p>
              );
            })()}

            {/* デバッグプレイ */}
            <div style={{ ...styles.resultBlock, width: '100%', maxWidth: 400, marginTop: 8, marginBottom: 20 }}>
              <div style={styles.resultBlockLabel}>デバッグプレイ</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
                <label style={{ fontSize: 12, color: '#a8a5b8' }}>
                  開始レベル：{debugStartLevel}
                  <input
                    type="range" min={1} max={CLEAR_LEVEL} value={debugStartLevel}
                    onChange={e => setDebugStartLevel(Number(e.target.value))}
                    style={{ width: '100%', marginTop: 4 }}
                  />
                </label>
                <label style={{ fontSize: 12, color: '#a8a5b8', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={debugGodMode} onChange={e => setDebugGodMode(e.target.checked)} />
                  無敵モード
                </label>
                <label style={{ fontSize: 12, color: '#a8a5b8' }}>
                  ゲーム速度：{debugSpeed}x
                  <select
                    value={debugSpeed}
                    onChange={e => setDebugSpeed(Number(e.target.value))}
                    style={{ width: '100%', marginTop: 4, background: '#1a1822', color: '#e8e6f0', border: '1px solid rgba(255,255,255,0.15)', padding: '6px 8px' }}
                  >
                    <option value={0.25}>0.25x（スロー）</option>
                    <option value={0.5}>0.5x</option>
                    <option value={1}>1x（通常）</option>
                    <option value={2}>2x</option>
                    <option value={4}>4x（高速）</option>
                  </select>
                </label>
                <button
                  className="aw-btn gold"
                  onClick={() => startRun(debugStartLevel, { debug: { godMode: debugGodMode, speedMul: debugSpeed } })}
                >
                  この設定でプレイ開始
                </button>
              </div>
            </div>

            {/* 全記録一覧 */}
            <div style={{ width: '100%', maxWidth: 500 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={styles.pdSectionTitle}>全記録一覧（{adminEntries.length}件）</div>
                <button className="aw-btn-sm" onClick={loadAdminEntries} disabled={adminLoading}>
                  {adminLoading ? '更新中…' : '更新'}
                </button>
              </div>
              <div style={styles.rankListWrap}>
                <div style={styles.rankList}>
                  {adminEntries.map(e => (
                    <div key={e.id} style={{ ...styles.rankRow, ...(e.cleared ? styles.rankRowCleared : {}), gridTemplateColumns: '1fr 46px 56px 44px 60px' }}>
                      <span style={styles.rankName}>{e.name}</span>
                      <span style={styles.rankLevel}>Lv.{e.level}</span>
                      <span style={styles.rankTime}>{Number(e.time).toFixed(1)}s</span>
                      <span style={{ fontSize: 10, color: '#6a6780' }}>gz{e.graze}</span>
                      <button
                        className="aw-btn-sm"
                        style={{ color: '#c41e3a' }}
                        disabled={adminDeletingId === e.id}
                        onClick={() => handleDeleteEntry(e.id)}
                      >
                        {adminDeletingId === e.id ? '…' : '削除'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ ...styles.btnRow, marginTop: 24 }}>
              <button className="aw-btn" onClick={handleAdminLogout}>ログアウト</button>
              <button className="aw-btn gold" onClick={() => setScreen('title')}>タイトルへ</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================
   スタイル定義
   ========================================================= */
const styles = {
  app: {
    width: '100%', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'radial-gradient(ellipse at 50% 20%, rgba(196,30,58,0.08), transparent 60%), radial-gradient(ellipse at 50% 100%, rgba(74,158,255,0.05), transparent 50%), #07060b',
    fontFamily: "'Shippori Mincho', serif", color: '#e8e6f0', overflow: 'hidden', userSelect: 'none',
    padding: 0
  },
  canvasWrap: {
    position: 'relative',
    // ビューポートの短辺いっぱいまで拡大しつつアスペクト比(2:3)を維持
    width: `min(100vw, calc(100vh * ${W / H}))`,
    height: `min(100vh, calc(100vw * ${H / W}))`,
    boxShadow: '0 0 0 1px rgba(212,175,55,0.15), 0 0 60px rgba(196,30,58,0.15), 0 0 120px rgba(0,0,0,0.8)'
  },
  canvas: { background: '#000', display: 'block', width: '100%', height: '100%', touchAction: 'none' },
  hud: { position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: "'JetBrains Mono', monospace" },
  hudTop: { position: 'absolute', top: 0, left: 0, right: 0, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 },
  levelRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  levelName: { color: '#c41e3a', fontWeight: 700, fontSize: 12, letterSpacing: '0.05em' },
  levelTag: { fontSize: 12, color: '#d4af37', fontWeight: 700, letterSpacing: '0.05em' },
  grazeText: { fontSize: 10, color: '#b967ff', letterSpacing: '0.1em', opacity: 0.85 },
  hudBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 11 },
  livesRow: { display: 'flex', gap: 6 },
  lifeDot: { width: 12, height: 12, background: '#d4af37', clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)', boxShadow: '0 0 8px rgba(212,175,55,0.6)' },
  lifeDotLost: { background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', boxShadow: 'none' },
  infoBlock: { textAlign: 'right', color: '#6a6780' },
  centerMsg: {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
    fontFamily: "'Shippori Mincho', serif", fontSize: 'clamp(1.6rem, 6vw, 2.6rem)', fontWeight: 800,
    textShadow: '0 0 30px rgba(196,30,58,0.7), 0 0 80px rgba(0,0,0,1)', letterSpacing: '0.1em', pointerEvents: 'none',
    whiteSpace: 'pre-line', textAlign: 'center'
  },
  volumeWrap: { position: 'absolute', top: 10, right: 14, pointerEvents: 'auto' },
  muteBtn: {
    background: 'rgba(0,0,0,0.4)',
    border: '1px solid rgba(212,175,55,0.3)', borderRadius: '50%', width: 34, height: 34,
    fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e8e6f0'
  },
  volumePopover: {
    position: 'absolute', top: 40, right: 0, display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgba(10,8,15,0.95)', border: '1px solid rgba(212,175,55,0.3)', borderRadius: 8,
    padding: '10px 12px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)', zIndex: 30
  },
  volumeSlider: { width: 90, accentColor: '#d4af37' },
  volumeValue: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#a8a5b8', width: 24, textAlign: 'right' },
  adminLink: {
    position: 'absolute', bottom: 8, right: 12, fontSize: 10, color: '#6a6780', opacity: 0.35,
    letterSpacing: '0.05em', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace"
  },
  debugOverlay: {
    position: 'absolute', top: 60, left: 10, fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
    lineHeight: 1.6, color: '#00fff2', background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(0,255,242,0.35)',
    padding: '6px 10px', pointerEvents: 'none', zIndex: 25, whiteSpace: 'nowrap'
  },
  screen: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    background: 'radial-gradient(ellipse at 50% 40%, rgba(20,10,25,0.97), rgba(5,3,8,0.99))', textAlign: 'center', padding: 20, zIndex: 20
  },
  eyebrow: { fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.3em', fontSize: 11, color: '#c41e3a', textTransform: 'uppercase', marginBottom: 12, opacity: 0.85 },
  title: {
    fontSize: 'clamp(2rem, 8vw, 3.2rem)', fontWeight: 800, letterSpacing: '0.08em',
    background: 'linear-gradient(180deg, #fff 0%, #d4af37 55%, #6b1120 100%)',
    WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
    textShadow: '0 0 40px rgba(196,30,58,0.3)', marginBottom: 6, lineHeight: 1.2
  },
  subtitle: { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#6a6780', letterSpacing: '0.15em', marginBottom: 28 },
  lore: { maxWidth: 460, fontSize: 13, lineHeight: 2, color: '#6a6780', marginBottom: 26, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.03em' },
  statRow: { display: 'flex', gap: 26, margin: '18px 0 26px', fontFamily: "'JetBrains Mono', monospace" },
  stat: { textAlign: 'center' },
  statNum: { fontSize: '1.6rem', fontWeight: 700, color: '#d4af37', display: 'block' },
  statLbl: { fontSize: 10, color: '#6a6780', letterSpacing: '0.12em', marginTop: 4, display: 'block' },
  btnRow: { display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' },
  mainActionRow: { display: 'flex', justifyContent: 'center', marginBottom: 14 },
  subActionRow: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  rankBadge: { fontFamily: "'JetBrains Mono', monospace", fontSize: '3rem', fontWeight: 700, margin: '6px 0' },
  resultBlock: {
    width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '16px 18px', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(212,175,55,0.18)'
  },
  resultBlockLabel: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#d4af37', letterSpacing: '0.12em',
    marginBottom: 12, textTransform: 'uppercase'
  },
  rankListWrap: { width: '100%', maxWidth: 420, maxHeight: 320, overflowY: 'auto', border: '1px solid rgba(212,175,55,0.2)', background: 'rgba(255,255,255,0.02)' },
  rankEmpty: { padding: 30, fontSize: 12, color: '#6a6780', fontFamily: "'JetBrains Mono', monospace" },
  rankList: { display: 'flex', flexDirection: 'column' },
  rankRow: {
    display: 'grid', gridTemplateColumns: '36px 1fr 60px 60px', alignItems: 'center', padding: '9px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.05)', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, minHeight: 40
  },
  rankRowTop: { background: 'rgba(212,175,55,0.06)' },
  rankRowCleared: { background: 'rgba(255,255,255,0.05)', borderLeft: '2px solid rgba(255,255,255,0.4)' },
  rankPos: { fontWeight: 700, fontSize: 13 },
  rankName: { textAlign: 'left', color: '#e8e6f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rankLevel: { color: '#d4af37', fontWeight: 700, textAlign: 'right' },
  rankTime: { color: '#4a9eff', textAlign: 'right' },
  scopeTabs: { display: 'flex', gap: 8, marginBottom: 16 },
  scopeTabActive: { padding: '8px 22px', fontSize: 12 },
  scopeTabInactive: { padding: '8px 22px', fontSize: 12, opacity: 0.45, borderColor: 'rgba(212,175,55,0.25)', background: 'transparent' },
  pdAnalysisGrid3: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, width: '100%', maxWidth: 380, marginBottom: 22
  },

  // プレイヤーデータ画面
  pdSectionTitle: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#d4af37', letterSpacing: '0.15em',
    alignSelf: 'flex-start', marginBottom: 12, borderLeft: '2px solid #d4af37', paddingLeft: 8
  },
  pdAnalysisGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, width: '100%', maxWidth: 440, marginBottom: 22
  },
  pdAnalysisCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 4px',
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(212,175,55,0.15)'
  },
  pdAnalysisNum: { fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 700, color: '#4a9eff' },
  pdAnalysisLbl: { fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: '#6a6780', marginTop: 4, letterSpacing: '0.05em', textAlign: 'center' },
  pdBandChart: { width: '100%', maxWidth: 440, marginBottom: 8 },
  pdBandRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  pdBandLabel: { fontFamily: "'JetBrains Mono', monospace", fontSize: 9, width: 78, flexShrink: 0, textAlign: 'right', color: '#a8a5b8' },
  pdBandBarTrack: { flex: 1, height: 12, background: 'rgba(255,255,255,0.04)', position: 'relative', overflow: 'hidden' },
  pdBandBarFill: { height: '100%', transition: 'width 0.4s ease' },
  pdBandCount: { fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#6a6780', width: 18, textAlign: 'right', flexShrink: 0 },
  pdTitleGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, width: '100%', maxWidth: 440, marginBottom: 8
  },
  pdTitleCard: {
    display: 'flex', flexDirection: 'column', padding: '10px 12px',
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(212,175,55,0.15)'
  },
  pdTitleCardLocked: { opacity: 0.5, border: '1px solid rgba(255,255,255,0.05)' },
  pdTitleName: { fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' },
  pdTitleRange: { fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#6a6780', marginTop: 3 }
};
