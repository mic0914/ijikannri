import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = new URL('../../', import.meta.url);
const index = fs.readFileSync(new URL('index.html', root), 'utf8');
const workerPublic = fs.readFileSync(new URL('cloudflare-worker/public/index.html', root), 'utf8');
assert.equal(index, workerPublic, 'two HTML entry points must be identical');

const legacyOpen = '<script>';
const legacyStart = index.indexOf(legacyOpen);
const legacyEnd = index.indexOf('</script>', legacyStart);
assert.ok(legacyStart >= 0 && legacyEnd > legacyStart, 'legacy script must exist');
new vm.Script(index.slice(legacyStart + legacyOpen.length, legacyEnd), { filename: 'fishery-script.js' });

const open = '<script id="port-rebuild-script">';
const start = index.indexOf(open);
const end = index.indexOf('</script>', start);
assert.ok(start >= 0 && end > start, 'port script must exist');
const source = index.slice(start + open.length, end);
new vm.Script(source, { filename: 'port-rebuild-script.js' });

const sandbox = {
  console,
  crypto: webcrypto,
  TextEncoder,
  Uint8Array,
  Date,
  Math,
  JSON,
  atob,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox);
const api = sandbox.__PORT_REBUILD_TEST__;
assert.ok(api, 'test API must be exposed');

const master = api.PORT_MASTER;
assert.equal(master.sourceFile, '港湾施設_点検診断_全施設_判定基準左端配置.xlsx');
const structures = master.facilityCategories.flatMap((category) => category.structures);
const sets = Object.values(master.criteriaSets);
const items = sets.flatMap((set) => set.items);
assert.equal(master.facilityCategories.length, 5);
assert.equal(structures.length, 42);
assert.equal(sets.length, 11);
assert.equal(items.length, 111);
assert.ok(structures.every((structure) => structure.criteriaSetRefs.length > 0 && structure.criteriaSetRefs.every((id) => master.criteriaSets[id])));
assert.equal(items.reduce((count, item) => count + ['a', 'b', 'c', 'd'].filter((rating) => Object.hasOwn(item.criteria, rating)).length, 0), 444);
assert.ok(items.every((item) => ['a', 'b', 'c', 'd'].every((rating) => typeof item.criteria[rating] === 'string' && item.criteria[rating].length > 0)));

const structure = structures.find((candidate) => api.portTargetsForStructure(candidate.id).length >= 2);
const targets = api.portTargetsForStructure(structure.id);
const state = api.createPortState();
state.facilityCategoryId = master.facilityCategories.find((category) => category.structures.some((candidate) => candidate.id === structure.id)).id;
state.structureId = structure.id;
state.portName = '検証港';
state.facilityName = '検証施設';
api.resizePortSpans(state, 4);
assert.equal(state.spans.length, 4);
assert.equal(new Set(state.spans.map((span) => span.id)).size, 4);
assert.ok(state.spans.every((span) => !('start' in span) && !('end' in span) && !('distance' in span)));
state.spans[0].currentTargetIndex = 1;
assert.equal(state.spans[1].currentTargetIndex, 0, 'span progress must be independent');
const restored = api.normalizePortState(JSON.parse(JSON.stringify(state)));
assert.equal(restored.appMode, 'port');
assert.equal(restored.spans.length, 4);
assert.equal(restored.spans[0].id, state.spans[0].id, 'span ids must survive reload normalization');

const first = api.ensurePortInspection(state.spans[0], targets[0]);
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
first.photos.push(
  { id: 'p1', data: jpeg, order: 9, mimeType: 'image/jpeg' },
  { id: 'p2', data: jpeg, order: 9, mimeType: 'image/jpeg' },
  { id: 'p3', data: jpeg, order: 9, mimeType: 'image/jpeg' },
);
api.reindexPortPhotos(first);
assert.deepEqual(Array.from(first.photos, (photo) => photo.order), [1, 2, 3]);
first.photos.splice(1, 1);
api.reindexPortPhotos(first);
assert.deepEqual(Array.from(first.photos, (photo) => photo.order), [1, 2]);
first.photos.push({ id: 'p4', data: jpeg, order: 8, mimeType: 'image/jpeg' });
api.reindexPortPhotos(first);
assert.deepEqual(Array.from(first.photos, (photo) => photo.order), [1, 2, 3]);
first.rating = 'a';
first.ratedAt = new Date().toISOString();
first.conditionComment = 'その他';
first.conditionFreeText = '検証コメント';
assert.equal(api.refreshPortInspectionStatus(first), 'completed');
first.rating = 'b';
assert.equal(api.refreshPortInspectionStatus(first), 'completed');
first.rating = 'a';

const skipped = api.ensurePortInspection(state.spans[0], targets[1]);
skipped.skipped = true;
skipped.skipReason = '水中部等で撮影不可';
assert.equal(api.refreshPortInspectionStatus(skipped), 'skipped');
const summary = api.summarizePortFacility(state);
assert.equal(summary.totals.a, 1, 'multiple photos must count as one rating');
assert.equal(summary.totals.rated, 1);
assert.equal(summary.totals.skipped, 1);
assert.equal(summary.totals.total, 4 * targets.length);
assert.equal(summary.spans[0].a, 1);
assert.equal(summary.spans[0].skipped, 1);
const restoredWithData = api.normalizePortState(JSON.parse(JSON.stringify(state)));
assert.equal(restoredWithData.spans[0].inspections[targets[0].id].photos.length, 3);
assert.equal(restoredWithData.spans[0].inspections[targets[0].id].rating, 'a');
assert.equal(restoredWithData.spans[0].inspections[targets[1].id].status, 'skipped');

const output = api.buildPortOutputData(state);
const xlsx = api.buildPortExcelBytes(output);
assert.deepEqual(Array.from(xlsx.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
const binary = Buffer.from(xlsx);
assert.ok(binary.includes(Buffer.from('[Content_Types].xml')));
assert.ok(binary.includes(Buffer.from('xl/media/image1.jpg')));
assert.ok(binary.includes(Buffer.from('xl/media/image2.jpg')));
const pdfHtml = api.buildPortPdfHtml(output);
assert.match(pdfHtml, /点検診断・a～d評価集計/);
assert.match(pdfHtml, /スパン1 写真帳/);
assert.match(pdfHtml, /スキップ記録/);

first.photos.length = 0;
api.refreshPortInspectionStatus(first);
assert.equal(first.status, 'pending');
assert.equal(first.rating, null);
assert.equal(first.ratedAt, null);
assert.equal(first.conditionComment, '');
assert.equal(first.conditionFreeText, '');

for (const marker of [
  'inspection-app-mode',
  'quay-normal-displacement-v2',
  'quay-normal-displacement-port-v1',
  '__LOCAL_INSPECTION_APP__',
  'capture="environment"',
  'JPG／JPEG／PNGをドラッグ＆ドロップ',
  'Ver.16.7',
  '維持管理計画・機能保全支援 ローカル点検アプリ 管理者用',
]) assert.ok(index.includes(marker), `missing marker: ${marker}`);
assert.match(source, /function portRatingArea\([^)]*\)\{if\(!record\.photos\.length\)return''/);
assert.match(index, /appMode:'fishery'/);
assert.match(index, /restoredMode=doc\.appMode\|\|'fishery'/);
assert.match(index, /if\(__startupMode!=='port'\)\{try\{const x=JSON\.parse\(localStorage\.getItem\(KEY\)\)/);
assert.match(source, /function savePort\(\).*localStorage\.setItem\(PORT_KEY/s);
assert.doesNotMatch(source, /localStorage\.setItem\(FISHERY_KEY/);
assert.match(source, /if\(mode!=='port'\)throw Error\('漁港またはモード不明のバックアップは港湾モードへ復元できません'\)/);

console.log('port rebuild static tests: OK');
