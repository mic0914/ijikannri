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

const caisson = structures.find((candidate) => candidate.name === 'ケーソン式係船岸');
assert.ok(caisson, 'ケーソン式係船岸 must exist');
const caissonTargets = api.portTargetsForStructure(caisson.id);
const caissonComponents = Array.from(api.portComponentsForTargets(caissonTargets));
assert.deepEqual(caissonComponents, ['岸壁法線', 'エプロン', 'ケーソン', 'エプロン（通常）', 'エプロン（利用制限が厳しい場合）', '上部工（RC）', '上部工（無筋）']);
assert.equal(new Set(caissonComponents).size, caissonComponents.length, 'component options must not contain duplicates');
assert.deepEqual(caissonComponents, Array.from(caissonTargets, (target) => target.component).filter((component, index, all) => all.indexOf(component) === index), 'component order must follow first appearance in PORT_MASTER order');

const ambiguousSpecifications = [
  ['ケーソン式防波堤', '施設全体'],
  ['ブロック式防波堤', '施設全体'],
  ['傾斜堤', '施設全体'],
  ...['前方斜め支え杭矢板壁式係船岸', 'セル式係船岸', 'デタッチドピア', '物揚場'].flatMap((structureName) => [
    [structureName, 'エプロン'],
    [structureName, 'エプロン（通常）'],
    [structureName, 'エプロン（利用制限が厳しい場合）'],
  ]),
];
assert.equal(ambiguousSpecifications.length, 15);
for (const [structureName, component] of ambiguousSpecifications) {
  const ambiguousStructure = structures.find((candidate) => candidate.name === structureName);
  const ambiguousTargets = api.portTargetsForStructure(ambiguousStructure.id);
  const sourceTarget = ambiguousTargets.find((candidate) => candidate.component !== component);
  const photo = api.createPortPhoto(sourceTarget, { id: 'ambiguity-span' }, { id: `${ambiguousStructure.id}-${component}` });
  photo.rating = 'a'; photo.ratedAt = '2026-08-21T00:00:00.000Z'; photo.conditionComment = 'その他'; photo.conditionFreeText = '旧評価';
  const result = api.setPortPhotoComponent(photo, component, ambiguousTargets);
  assert.equal(result.status, 'choice-required', `${structureName} / ${component} must require user selection`);
  assert.ok(result.candidates.length >= 2);
  assert.equal(photo.inspectionItemId, null, 'multiple candidates must never be selected automatically');
  assert.equal(photo.criteriaSetId, null);
  assert.equal(photo.rating, null, 'changing criteria must clear the previous rating');
  assert.equal(photo.conditionFreeText, '', 'changing criteria must clear the previous comment');
  assert.equal(api.portPhotoSelectionModel(photo, ambiguousTargets).choiceRequired, true);
  const selected = result.candidates.at(-1);
  assert.equal(api.setPortPhotoInspectionItem(photo, selected.id, ambiguousTargets).status, 'resolved');
  const selectedModel = api.portPhotoSelectionModel(photo, ambiguousTargets);
  assert.equal(selectedModel.item.id, selected.id);
  assert.equal(selectedModel.item.criteriaSetId, selected.criteriaSetId);
  assert.ok(['a', 'b', 'c', 'd'].every((rating) => selectedModel.item.criteria[rating] === selected.criteria[rating]));
}
const caissonBreakwater = structures.find((candidate) => candidate.name === 'ケーソン式防波堤');
const breakwaterTargets = api.portTargetsForStructure(caissonBreakwater.id);
const facilityCandidates = api.portPhotoCandidates(breakwaterTargets, '施設全体');
assert.deepEqual(Array.from(facilityCandidates, (candidate) => candidate.diagnosisItem), ['移動', '沈下']);
const fixedInitialPhoto = api.createPortPhoto(facilityCandidates[0], { id: 'initial-span' }, { id: 'fixed-initial' });
assert.equal(api.portPhotoSelectionModel(fixedInitialPhoto, breakwaterTargets).choiceRequired, false, 'a new photo keeps the push target even if its component has multiple items');
assert.equal(api.portPhotoSelectionModel(fixedInitialPhoto, breakwaterTargets).resolved, true);
const ambiguousPhoto = api.createPortPhoto(breakwaterTargets.find((candidate) => candidate.component === 'ケーソン'), { id: 'ambiguous-span' }, { id: 'ambiguous-photo' });
api.setPortPhotoComponent(ambiguousPhoto, '施設全体', breakwaterTargets);
assert.equal(api.refreshPortInspectionStatus({ photos: [ambiguousPhoto], skipped: false }), 'photos', 'an unresolved inspection item must keep the target incomplete');
api.setPortPhotoInspectionItem(ambiguousPhoto, facilityCandidates[0].id, breakwaterTargets);
Object.assign(ambiguousPhoto, { rating: 'a', ratedAt: '2026-08-21T00:00:00.000Z', conditionComment: 'その他', conditionFreeText: '移動評価' });
assert.equal(api.portPhotoSelectionModel(ambiguousPhoto, breakwaterTargets).item.criteria.a, facilityCandidates[0].criteria.a);
api.setPortPhotoInspectionItem(ambiguousPhoto, facilityCandidates[1].id, breakwaterTargets);
assert.equal(ambiguousPhoto.rating, null, 'changing the inspection item must clear its previous rating');
assert.equal(ambiguousPhoto.conditionFreeText, '');
assert.equal(api.portPhotoSelectionModel(ambiguousPhoto, breakwaterTargets).item.criteria.a, facilityCandidates[1].criteria.a, 'criteria must follow the selected inspection item');

let multipleComponentCases = 0;
for (const candidateStructure of structures) {
  const candidateTargets = api.portTargetsForStructure(candidateStructure.id);
  for (const component of api.portComponentsForTargets(candidateTargets)) {
    const candidates = api.portPhotoCandidates(candidateTargets, component);
    if (candidates.length < 2) continue;
    multipleComponentCases++;
    const source = candidateTargets.find((candidate) => candidate.component !== component) || candidateTargets[0];
    const photo = api.createPortPhoto(source, { id: 'all-multiple-span' }, { id: `${candidateStructure.id}-${multipleComponentCases}` });
    const result = api.setPortPhotoComponent(photo, component, candidateTargets);
    assert.equal(result.status, 'choice-required');
    assert.equal(photo.inspectionItemId, null);
    const labels = candidates.map((candidate) => api.portInspectionItemLabel(candidate, candidates));
    assert.equal(new Set(labels).size, candidates.length, `${candidateStructure.name} / ${component} must present distinguishable inspection item labels`);
  }
}
assert.equal(multipleComponentCases, 68, 'every multi-item component in PORT_MASTER must require user selection after component change');

const directState = api.createPortState();
directState.structureId = caisson.id;
const directSpan = directState.spans[0];
const wallIndex = api.selectPortComponent(directSpan, caissonTargets, '岸壁法線');
const wallTarget = caissonTargets[wallIndex];
const wallRecord = api.ensurePortInspection(directSpan, wallTarget);
wallRecord.photos.push({ id: 'wall-photo', inspectionItemId: wallTarget.id, criteriaSetId: wallTarget.criteriaSetId, component: wallTarget.component, order: 1, rating: 'a', ratedAt: '2026-08-21T01:00:00.000Z', conditionComment: 'その他', conditionFreeText: '岸壁法線写真', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
api.refreshPortInspectionStatus(wallRecord);
const upperIndex = api.selectPortComponent(directSpan, caissonTargets, '上部工（RC）');
assert.equal(caissonTargets[upperIndex].component, '上部工（RC）', 'users must be able to navigate away from 岸壁法線');
api.selectPortComponent(directSpan, caissonTargets, '岸壁法線');
assert.equal(directSpan.inspections[wallTarget.id].photos[0].inspectionItemId, wallTarget.id);
assert.equal(directSpan.inspections[wallTarget.id].photos[0].rating, 'a', 'component navigation must preserve per-photo ratings');
const apronTarget = caissonTargets.find((target) => target.component === 'エプロン');
const apronRecord = api.ensurePortInspection(directSpan, apronTarget);
apronRecord.skipped = true; apronRecord.skipReason = '該当なし'; api.refreshPortInspectionStatus(apronRecord);
api.selectPortComponent(directSpan, caissonTargets, '上部工（無筋）');
assert.equal(directSpan.inspections[apronTarget.id].status, 'skipped', 'component navigation must preserve skipped targets');
const directOutput = api.buildPortOutputData(directState);
const wallEntry = directOutput.spans[0].entries.find((entry) => entry.target.id === wallTarget.id);
assert.equal(wallEntry.target.component, '岸壁法線');
assert.equal(wallEntry.record.photos[0].inspectionItemId, wallTarget.id, 'output data must retain target/component relationships');
assert.ok(Buffer.from(api.buildPortExcelBytes(directOutput)).includes(Buffer.from('岸壁法線')), 'Excel must retain the selected target component');
const directPdf = api.buildPortPdfHtml(directOutput);
assert.match(directPdf, /岸壁法線/);
assert.match(directPdf, /凹凸・出入り/);

const repeatedStructure = structures.find((candidate) => {
  const counts = new Map();
  for (const target of api.portTargetsForStructure(candidate.id)) counts.set(target.component, (counts.get(target.component) || 0) + 1);
  return [...counts.values()].some((count) => count >= 3);
});
const repeatedTargets = api.portTargetsForStructure(repeatedStructure.id);
const repeatedComponent = api.portComponentsForTargets(repeatedTargets).find((component) => api.portTargetIndexesForComponent(repeatedTargets, component).length >= 3);
const repeatedIndexes = Array.from(api.portTargetIndexesForComponent(repeatedTargets, repeatedComponent));
const repeatedState = api.createPortState(); repeatedState.structureId = repeatedStructure.id;
const repeatedSpan = repeatedState.spans[0];
const completedRecord = api.ensurePortInspection(repeatedSpan, repeatedTargets[repeatedIndexes[0]]); completedRecord.status = 'completed';
const skippedRecord = api.ensurePortInspection(repeatedSpan, repeatedTargets[repeatedIndexes[1]]); skippedRecord.status = 'skipped'; skippedRecord.skipped = true;
assert.equal(api.selectPortComponent(repeatedSpan, repeatedTargets, repeatedComponent), repeatedIndexes[2], 'component selection must open its first incomplete target');
const repeatedProgress = api.portComponentProgress(repeatedSpan, repeatedTargets, repeatedSpan.currentTargetIndex);
assert.equal(repeatedProgress.position, 3);
assert.equal(repeatedProgress.completed, 2);
for (const index of repeatedIndexes) {
  const record = api.ensurePortInspection(repeatedSpan, repeatedTargets[index]);
  record.status = index === repeatedIndexes[1] ? 'skipped' : 'completed';
}
assert.equal(api.selectPortComponent(repeatedSpan, repeatedTargets, repeatedComponent), repeatedIndexes[0], 'a fully completed component must reopen at its first target');
assert.equal(api.adjacentPortTargetIndex(repeatedTargets, repeatedIndexes[0], 1), repeatedIndexes[1], 'push navigation must remain inside the selected component in PORT_MASTER order');

const structure = caisson;
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
const photo1 = api.createPortPhoto(targets[0], state.spans[0], { id: 'p1', data: jpeg, order: 9, mimeType: 'image/jpeg' });
Object.assign(photo1, { rating: 'a', ratedAt: '2026-08-21T00:00:00.000Z', conditionComment: 'その他', conditionFreeText: 'コメントA' });
const photo2 = api.createPortPhoto(targets[0], state.spans[0], { id: 'p2', data: jpeg, order: 9, mimeType: 'image/jpeg' });
assert.equal(api.setPortPhotoComponent(photo2, 'エプロン', targets).status, 'resolved', 'a single-candidate component must resolve automatically');
Object.assign(photo2, { rating: 'c', ratedAt: '2026-08-21T00:01:00.000Z', conditionComment: 'その他', conditionFreeText: '' });
first.photos.push(photo1, photo2);
api.reindexPortPhotos(first);
assert.deepEqual(Array.from(first.photos, (photo) => photo.order), [1, 2]);
assert.equal(api.refreshPortInspectionStatus(first), 'photos', 'one incomplete photo keeps the target incomplete');
first.photos[1].conditionFreeText = 'コメントC';
assert.equal(api.refreshPortInspectionStatus(first), 'completed');
assert.equal(first.photos[0].rating, 'a');
assert.equal(first.photos[1].rating, 'c');
assert.equal(first.photos[0].component, '岸壁法線');
assert.equal(first.photos[1].component, 'エプロン');
assert.notEqual(first.photos[0].inspectionItemId, first.photos[1].inspectionItemId);
const photo1Snapshot = JSON.stringify(first.photos[0]);
assert.equal(api.setPortPhotoComponent(first.photos[1], 'ケーソン', targets).status, 'resolved');
assert.equal(first.photos[1].rating, null, 'changing photo 2 criteria must clear only photo 2 assessment');
assert.equal(JSON.stringify(first.photos[0]), photo1Snapshot, 'changing photo 2 must not affect photo 1');
assert.equal(api.setPortPhotoComponent(first.photos[1], 'エプロン', targets).status, 'resolved');
Object.assign(first.photos[1], { rating: 'c', ratedAt: '2026-08-21T00:01:00.000Z', conditionComment: 'その他', conditionFreeText: 'コメントC' });
assert.equal(api.refreshPortInspectionStatus(first), 'completed');

const reload = api.normalizePortState(JSON.parse(JSON.stringify(state)));
const reloadedPhotos = reload.spans[0].inspections[targets[0].id].photos;
assert.equal(reloadedPhotos[0].rating, 'a');
assert.equal(reloadedPhotos[1].rating, 'c');
assert.equal(reloadedPhotos[0].component, '岸壁法線');
assert.equal(reloadedPhotos[1].component, 'エプロン');
reloadedPhotos[0].rating = 'b';
assert.equal(reloadedPhotos[1].rating, 'c', 'changing photo 1 must not change photo 2');
reloadedPhotos[0].rating = 'a';

const photo3 = api.createPortPhoto(targets[0], state.spans[0], { id: 'p3', data: jpeg, order: 8, mimeType: 'image/jpeg' });
assert.equal(photo3.component, targets[0].component, 'new photo component must copy the current push target');
assert.equal(photo3.inspectionItemId, targets[0].id, 'new photo inspection item must copy the current push target');
assert.equal(photo3.criteriaSetId, targets[0].criteriaSetId);
assert.equal(api.setPortPhotoComponent(photo3, '上部工（RC）', targets).status, 'resolved');
first.photos.push(photo3);
api.reindexPortPhotos(first);
assert.equal(first.photos[0].rating, 'a', 'adding a photo must preserve photo 1');
assert.equal(first.photos[1].rating, 'c', 'adding a photo must preserve photo 2');
assert.equal(api.refreshPortInspectionStatus(first), 'photos');
first.photos[2].rating = 'd';
first.photos[2].ratedAt = '2026-08-21T00:02:00.000Z';
first.photos[2].conditionComment = 'その他';
first.photos[2].conditionFreeText = 'コメントD';
assert.equal(api.refreshPortInspectionStatus(first), 'completed');

const skipped = api.ensurePortInspection(state.spans[0], targets[2]);
skipped.skipped = true;
skipped.skipReason = '水中部等で撮影不可';
assert.equal(api.refreshPortInspectionStatus(skipped), 'skipped');
const summary = api.summarizePortFacility(state);
assert.equal(summary.totals.a, 1);
assert.equal(summary.totals.c, 1);
assert.equal(summary.totals.d, 1);
assert.equal(summary.totals.rated, 3, 'ratings must be counted per photo');
assert.equal(summary.totals.completed, 1, 'completion must be counted per target');
assert.equal(summary.totals.skipped, 1);
assert.equal(summary.totals.total, 4 * targets.length);
assert.equal(summary.spans[0].a, 1);
assert.equal(summary.spans[0].c, 1);
assert.equal(summary.spans[0].d, 1);
assert.equal(summary.spans[0].skipped, 1);
assert.equal(summary.totals.completionRate, Math.round(2 / summary.totals.total * 1000) / 10);
assert.equal(summary.details.a[0].component, '岸壁法線');
assert.equal(summary.details.a[0].diagnosisItem, '凹凸・出入り');
const collected = api.collectPortResults(state);
assert.deepEqual(Array.from(collected.photoResults, (result) => result.component), ['岸壁法線', 'エプロン', '上部工（RC）']);
const restoredWithData = api.normalizePortState(JSON.parse(JSON.stringify(state)));
assert.equal(restoredWithData.spans[0].inspections[targets[0].id].photos.length, 3);
assert.deepEqual(Array.from(restoredWithData.spans[0].inspections[targets[0].id].photos, (photo) => photo.rating), ['a', 'c', 'd']);
assert.deepEqual(Array.from(restoredWithData.spans[0].inspections[targets[0].id].photos, (photo) => photo.component), ['岸壁法線', 'エプロン', '上部工（RC）']);
assert.equal(restoredWithData.spans[0].inspections[targets[2].id].status, 'skipped');

const legacyState = api.createPortState();
legacyState.structureId = structure.id;
const legacyRecord = api.ensurePortInspection(legacyState.spans[0], targets[0]);
legacyRecord.photos = [{ id: 'old-1', inspectionItemId: targets[0].id, data: jpeg }, { id: 'old-2', inspectionItemId: targets[0].id, component: targets[0].component, data: jpeg }];
legacyRecord.rating = 'b'; legacyRecord.ratedAt = '2026-08-20T00:00:00.000Z'; legacyRecord.conditionComment = 'その他'; legacyRecord.conditionFreeText = '旧コメント';
const migrated = api.normalizePortState(JSON.parse(JSON.stringify(legacyState))).spans[0].inspections[targets[0].id];
assert.deepEqual(Array.from(migrated.photos, (photo) => photo.rating), ['b', 'b']);
assert.deepEqual(Array.from(migrated.photos, (photo) => photo.component), [targets[0].component, targets[0].component], 'missing components are filled from inspectionItemId and existing components are preserved');
assert.ok(migrated.photos.every((photo) => photo.criteriaSetId === targets[0].criteriaSetId));
assert.ok(migrated.photos.every((photo) => photo.conditionFreeText === '旧コメント'));
assert.ok(!Object.hasOwn(migrated, 'rating') && !Object.hasOwn(migrated, 'conditionComment'), 'legacy target fields must not remain in new saves');
assert.equal(migrated.status, 'completed');

const output = api.buildPortOutputData(state);
assert.equal(output.itemCounts.find((item) => item.id === first.photos[0].inspectionItemId).counts.a, 1);
assert.equal(output.itemCounts.find((item) => item.id === first.photos[1].inspectionItemId).counts.c, 1);
assert.equal(output.itemCounts.find((item) => item.id === first.photos[2].inspectionItemId).counts.d, 1);
const xlsx = api.buildPortExcelBytes(output);
assert.deepEqual(Array.from(xlsx.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
const binary = Buffer.from(xlsx);
assert.ok(binary.includes(Buffer.from('[Content_Types].xml')));
assert.ok(binary.includes(Buffer.from('xl/media/image1.jpg')));
assert.ok(binary.includes(Buffer.from('xl/media/image2.jpg')));
assert.ok(binary.includes(Buffer.from('xl/media/image3.jpg')));
function storedZipEntries(bytes) {
  const entries = new Map(); let offset = 0; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30, dataStart = nameStart + nameLength + extraLength;
    entries.set(new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength)), bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}
const entries = storedZipEntries(xlsx);
const summaryXml = new TextDecoder().decode(entries.get('xl/worksheets/sheet1.xml'));
const photoXml = new TextDecoder().decode(entries.get('xl/worksheets/sheet2.xml'));
assert.match(summaryXml, /a判定写真数/);
assert.match(summaryXml, /c判定写真数/);
for (const expected of ['岸壁法線', 'エプロン', '上部工（RC）', '凹凸・出入り', '沈下・陥没', 'コンクリートの劣化・損傷', 'コメントA', 'コメントC', 'コメントD', '>a<', '>c<', '>d<']) assert.ok(photoXml.includes(expected), `Excel missing ${expected}`);
const pdfHtml = api.buildPortPdfHtml(output);
assert.match(pdfHtml, /点検診断・a～d評価集計/);
assert.match(pdfHtml, /スパン1 写真帳/);
assert.match(pdfHtml, /スキップ記録/);
for (const expected of ['岸壁法線', 'エプロン', '上部工（RC）', '凹凸・出入り', '沈下・陥没', 'コンクリートの劣化・損傷', '評価 a', '評価 c', '評価 d', 'コメントA', 'コメントC', 'コメントD']) assert.ok(pdfHtml.includes(expected), `PDF missing ${expected}`);

const keptPhoto = first.photos[1];
first.photos.splice(0, 1);
api.reindexPortPhotos(first);
assert.equal(first.photos[0].id, keptPhoto.id);
assert.equal(first.photos[0].rating, 'c', 'deleting photo 1 must preserve photo 2 rating');
assert.deepEqual(Array.from(first.photos, (photo) => photo.order), [1, 2]);
first.photos.length = 0;
api.refreshPortInspectionStatus(first);
assert.equal(first.status, 'pending');
assert.ok(!Object.hasOwn(first, 'rating'));

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
assert.doesNotMatch(source, /function portRatingArea/);
assert.doesNotMatch(source, /<h3>a～d劣化度<\/h3>/);
assert.match(source, /data-port-photo-rating/);
assert.match(source, /portItemById\(photo\.inspectionItemId\)/);
assert.match(source, /data-port-photo-component/);
assert.match(source, /data-port-photo-inspection-item/);
assert.match(source, /model\.choiceRequired\?/);
assert.match(source, /model\.resolved\?'':'disabled'/);
assert.doesNotMatch(source, /<select data-port-component/);
assert.match(source, /部材：\$\{esc\(target\.component/);
assert.match(index, /appMode:'fishery'/);
assert.match(index, /restoredMode=doc\.appMode\|\|'fishery'/);
assert.match(index, /if\(__startupMode!=='port'\)\{try\{const x=JSON\.parse\(localStorage\.getItem\(KEY\)\)/);
assert.match(source, /function savePort\(\).*localStorage\.setItem\(PORT_KEY/s);
assert.doesNotMatch(source, /localStorage\.setItem\(FISHERY_KEY/);
assert.match(source, /if\(mode!=='port'\)throw Error\('漁港またはモード不明のバックアップは港湾モードへ復元できません'\)/);

console.log('port rebuild static tests: OK');
