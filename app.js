import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { LaneCounter, assignPosesToLanes } from './counter.js';

const $ = id => document.getElementById(id);
const camera = $('camera');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const MODEL_PATH = './assets/pose_landmarker_lite.task';
const WASM_PATH = './assets/wasm';
const HISTORY_KEY = 'jump-rope-sessions-v1';

let detector;
let stream;
let ready = false;
let running = false;
let lanes = [];
let lastVideoTime = -1;
let lastInferenceAt = 0;
let lastRenderAt = 0;
let inferenceSamples = [];
let assignments = new Map();
let elapsedBeforeRun = 0;
let runStartedAt = 0;
let sessionSaved = false;
let sessionDate = null;
let lastError = '';

const laneCount = () => Number($('lane-count').value);
const durationMs = () => Number($('duration').value) * 1000;
const settings = () => ({
  amplitudeRatio: Number($('sensitivity').value),
  minInterval: Number($('interval').value)
});
const elapsedMs = (now = performance.now()) => elapsedBeforeRun + (running ? now - runStartedAt : 0);
const formattedTime = ms => {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor(tenths / 10) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
};

function setStatus(text) { $('status').textContent = text; }
function makeLanes() { lanes = Array.from({ length: laneCount() }, (_, i) => new LaneCounter(i + 1)); }
makeLanes();

function renderCards(now) {
  const existing = $('lane-cards');
  if (existing.children.length !== lanes.length) {
    existing.replaceChildren();
    for (const lane of lanes) {
      const card = document.createElement('article');
      card.className = 'lane-card';
      card.innerHTML = `<span class="lane-title">站位 ${lane.id}</span><span class="lane-status">待识别</span>
        <div class="lane-count">0</div><div class="corrections">
          <button type="button" aria-label="站位 ${lane.id} 减一" data-id="${lane.id}" data-delta="-1">−</button>
          <button type="button" aria-label="站位 ${lane.id} 加一" data-id="${lane.id}" data-delta="1">＋</button>
        </div>`;
      existing.append(card);
    }
  }
  for (const lane of lanes) {
    const card = existing.children[lane.id - 1];
    const detected = now - lane.lastSeen < 600;
    card.classList.toggle('active', detected);
    card.classList.toggle('lost', !detected && ready);
    card.querySelector('.lane-count').textContent = lane.count;
    card.querySelector('.lane-status').textContent = detected ? (lane.state === 'air' ? '起跳中' : '已识别') : '未识别';
  }
}

function currentView() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const videoWidth = camera.videoWidth || width;
  const videoHeight = camera.videoHeight || height;
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const xOffset = (width - videoWidth * scale) / 2;
  const yOffset = (height - videoHeight * scale) / 2;
  return {
    width, height,
    x: x => x * videoWidth * scale + xOffset,
    y: y => y * videoHeight * scale + yOffset,
    xRatio: x => (x * videoWidth * scale + xOffset) / width
  };
}

function paint(now) {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
  }
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const view = currentView();

  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 5]);
  for (let i = 1; i < lanes.length; i++) {
    const x = i * width / lanes.length;
    ctx.strokeStyle = '#fff9';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const [laneIndex, assigned] of assignments) {
    const lane = lanes[laneIndex];
    if (!lane) continue;
    const color = lane.state === 'air' ? '#facc63' : '#5bf3cc';
    const points = assigned.landmarks.map(p => ({ x: view.x(p.x), y: view.y(p.y), visibility: p.visibility }));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const edge of PoseLandmarker.POSE_CONNECTIONS) {
      const a = points[edge.start], b = points[edge.end];
      if (!a || !b || (a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.fillStyle = '#e5faff';
    for (const point of points) {
      if ((point.visibility ?? 1) < 0.35) continue;
      ctx.beginPath(); ctx.arc(point.x, point.y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    const labelX = Math.min(width - 72, Math.max(4, view.x(assigned.x) - 27));
    const labelY = Math.max(26, view.y(assigned.y - assigned.torso) - 25);
    ctx.fillStyle = '#061626d9';
    ctx.fillRect(labelX, labelY - 22, 76, 26);
    ctx.fillStyle = color;
    ctx.font = 'bold 17px -apple-system,sans-serif';
    ctx.fillText(`#${lane.id}  ${lane.count}`, labelX + 5, labelY - 4);
  }
  // Draw lane numbers even before the detector sees a person.
  ctx.textAlign = 'center';
  ctx.font = 'bold 13px -apple-system,sans-serif';
  for (let i = 0; i < lanes.length; i++) {
    const x = (i + 0.5) * width / lanes.length;
    ctx.fillStyle = '#081421bb'; ctx.fillRect(x - 17, height - 32, 34, 23);
    ctx.fillStyle = '#e5faff'; ctx.fillText(String(i + 1), x, height - 16);
  }
  ctx.textAlign = 'left';
}

function refresh(now = performance.now()) {
  $('timer').textContent = formattedTime(elapsedMs(now));
  $('detected').textContent = assignments.size;
  const fps = inferenceSamples.length < 2 ? 0 :
    Math.round(1000 * (inferenceSamples.length - 1) / (inferenceSamples.at(-1) - inferenceSamples[0]));
  $('fps').textContent = fps;
  $('perf-warning').hidden = !ready || fps === 0 || fps >= 12;
  renderCards(now);
  $('btn-start').disabled = !ready || running;
  $('btn-pause').disabled = !running;
  $('btn-save').disabled = running || !sessionDate || sessionSaved;
}

function loop(now) {
  requestAnimationFrame(loop);
  if (!ready || camera.readyState < 2 || document.hidden) return;

  if (camera.currentTime !== lastVideoTime && now - lastInferenceAt >= 40) {
    lastInferenceAt = now;
    lastVideoTime = camera.currentTime;
    try {
      const result = detector.detectForVideo(camera, now);
      const view = currentView();
      assignments = assignPosesToLanes(result.landmarks, lanes.length, view.xRatio);
      if (running) {
        for (let i = 0; i < lanes.length; i++) {
          const match = assignments.get(i);
          if (match) lanes[i].observe(match.y, match.torso, now, settings());
          else lanes[i].missing(now);
        }
      } else {
        // Preview should display detection status without changing any score.
        for (let i = 0; i < lanes.length; i++) {
          if (assignments.has(i)) lanes[i].lastSeen = now;
        }
      }
      inferenceSamples.push(now);
      while (inferenceSamples.length > 1 && now - inferenceSamples[0] > 2000) inferenceSamples.shift();
      paint(now);
    } catch (error) {
      if (error.message !== lastError) {
        lastError = error.message;
        setStatus(`识别异常：${error.message}。请重新载入页面。`);
      }
      pause();
    }
  }
  if (running && durationMs() > 0 && elapsedMs(now) >= durationMs()) {
    elapsedBeforeRun = durationMs();
    running = false;
    setStatus('计时结束，已停止计数；可以修正次数后保存。');
    $('btn-save').disabled = false;
  }
  if (now - lastRenderAt > 150) { lastRenderAt = now; refresh(now); }
}
requestAnimationFrame(loop);

async function openCamera() {
  if (ready) return;
  $('btn-camera').disabled = true;
  $('stage-message').textContent = '正在加载人体识别模型，请稍候…';
  setStatus('正在从本站加载轻量模型和计算组件，首次启动可能较慢。');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前页面不支持摄像头。请通过 HTTPS 在 Safari 打开。');
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    const options = {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
      runningMode: 'VIDEO', numPoses: laneCount(),
      minPoseDetectionConfidence: 0.35,
      minPosePresenceConfidence: 0.35,
      minTrackingConfidence: 0.4
    };
    try {
      detector = await PoseLandmarker.createFromOptions(vision, options);
    } catch (gpuError) {
      setStatus('GPU 初始化未成功，尝试兼容模式（CPU）…');
      options.baseOptions.delegate = 'CPU';
      detector = await PoseLandmarker.createFromOptions(vision, options);
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    });
    camera.srcObject = stream;
    await camera.play();
    ready = true;
    $('btn-camera').textContent = '摄像头已开启';
    $('stage-message').hidden = true;
    setStatus('摄像头已开启。请检查骨架与站位编号，再点击「开始计数」。');
    refresh();
  } catch (error) {
    $('stage-message').textContent = '启动失败，请检查摄像头权限和网络';
    $('btn-camera').disabled = false;
    setStatus(`启动失败：${error.message}`);
    console.error(error);
  }
}

function start() {
  if (!ready || running) return;
  if (sessionSaved || !sessionDate) {
    if (sessionSaved) reset();
    sessionDate = new Date().toISOString();
  }
  running = true;
  runStartedAt = performance.now();
  $('btn-save').disabled = true;
  setStatus('正在计数：黄颜色表示起跳中，绿色表示已落地。');
}

function pause() {
  if (!running) return;
  elapsedBeforeRun = elapsedMs();
  running = false;
  setStatus('已暂停。可继续、修正或保存成绩。');
  refresh();
}

function reset() {
  running = false;
  elapsedBeforeRun = 0;
  sessionDate = null;
  sessionSaved = false;
  lanes.forEach(lane => lane.reset());
  setStatus('次数与计时已清零。');
  refresh();
}

function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function save() {
  if (running || !sessionDate || sessionSaved) return;
  const history = readHistory();
  const entry = {
    date: sessionDate, seconds: Math.round(elapsedMs() / 1000),
    positions: lanes.map(lane => ({ position: lane.id, count: lane.count }))
  };
  const existingIndex = history.findIndex(item => item.date === sessionDate);
  if (existingIndex >= 0) history.splice(existingIndex, 1);
  history.unshift(entry);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
    sessionSaved = true;
    setStatus('本次成绩已保存在当前 iPhone 浏览器，可导出 CSV。');
  } catch (error) {
    setStatus(`保存失败（可能为无痕模式或存储空间不足）：${error.message}`);
  }
  refresh();
}

function exportCsv() {
  const sessions = readHistory();
  if (!sessions.length) { setStatus('暂无历史记录。请先结束训练并保存成绩。'); return; }
  const lines = [['训练时间', '持续秒数', '站位编号', '跳绳次数']];
  for (const s of sessions) for (const p of s.positions) {
    lines.push([s.date, s.seconds, p.position, p.count]);
  }
  const csv = '\ufeff' + lines.map(row => row.join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `跳绳成绩-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function showHistory() {
  const entries = readHistory();
  const root = $('history-list');
  root.replaceChildren();
  if (!entries.length) root.textContent = '还没有保存的成绩。';
  for (const session of entries) {
    const card = document.createElement('div');
    card.className = 'history-entry';
    const title = document.createElement('strong');
    title.textContent = `${new Date(session.date).toLocaleString('zh-CN')} · ${session.seconds} 秒`;
    const counts = document.createElement('div');
    counts.textContent = session.positions.map(p => `#${p.position}: ${p.count}次`).join('　');
    card.append(title, counts); root.append(card);
  }
  $('history-dialog').showModal();
}

$('btn-camera').addEventListener('click', openCamera);
$('btn-start').addEventListener('click', start);
$('btn-pause').addEventListener('click', pause);
$('btn-reset').addEventListener('click', reset);
$('btn-save').addEventListener('click', save);
$('btn-export').addEventListener('click', exportCsv);
$('btn-history').addEventListener('click', showHistory);
$('btn-close-history').addEventListener('click', () => $('history-dialog').close());
$('lane-cards').addEventListener('click', event => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  const lane = lanes[Number(button.dataset.id) - 1];
  if (!lane) return;
  lane.adjust(Number(button.dataset.delta));
  if (sessionSaved) { sessionSaved = false; setStatus('成绩已修改，点击「保存成绩」更新本次历史记录。'); }
  renderCards(performance.now());
});
$('lane-count').addEventListener('change', async () => {
  if (running) pause();
  reset();
  makeLanes();
  assignments.clear();
  refresh();
  if (detector) {
    try { await detector.setOptions({ numPoses: laneCount() }); }
    catch (error) { setStatus(`切换人数失败：${error.message}；请刷新重试。`); }
  }
  setStatus(`已切换为 ${laneCount()} 个固定站位。学生需各自站在对应分区。`);
});
window.addEventListener('pagehide', () => {
  stream?.getTracks().forEach(track => track.stop());
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
refresh();
