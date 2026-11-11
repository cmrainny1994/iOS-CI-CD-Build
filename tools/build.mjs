import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = 'dist';
await mkdir(path.join(output, 'assets', 'wasm'), { recursive: true });
await Promise.all(['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'icon.svg'].map(
  file => cp(file, path.join(output, file))
));
await cp('node_modules/@mediapipe/tasks-vision/wasm', path.join(output, 'assets', 'wasm'), { recursive: true });
await build({ entryPoints: ['app.js'], bundle: true, format: 'esm', minify: true,
  target: ['safari16'], outfile: path.join(output, 'app.js') });

const modelUrl = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const modelPath = path.join(output, 'assets', 'pose_landmarker_lite.task');
const response = await fetch(modelUrl, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw new Error(`Failed to download model: ${response.status}`);
const model = Buffer.from(await response.arrayBuffer());
if (model.length < 100000) throw new Error('Downloaded model is unexpectedly small');
await writeFile(modelPath, model);
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.webmanifest'), 'utf8'));
console.log(`Built ${manifest.name}; model ${(model.length / 1048576).toFixed(1)} MiB`);
