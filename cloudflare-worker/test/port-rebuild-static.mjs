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
  Blob,
  Date,
  Math,
  JSON,
  atob,
  btoa,
  URL,
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

assert.equal(api.portUiModeFromUrl('https://preview.invalid/?mode=port&ui=pc', { coarse: true, maxTouchPoints: 5, viewportWidth: 800 }), 'pc');
assert.equal(api.portUiModeFromUrl('https://preview.invalid/?mode=port&ui=mobile', { coarse: false, maxTouchPoints: 0, viewportWidth: 1440 }), 'mobile');
assert.equal(api.resolvePortUiMode({ coarse: true, maxTouchPoints: 5, viewportWidth: 1024 }), 'mobile');
assert.equal(api.resolvePortUiMode({ coarse: false, maxTouchPoints: 5, viewportWidth: 1024, platform: 'MacIntel' }), 'mobile', 'iPad-class MacIntel touch devices must use mobile UI');
assert.equal(api.resolvePortUiMode({ coarse: false, maxTouchPoints: 10, viewportWidth: 1440, platform: 'Win32' }), 'pc', 'wide touch-enabled PCs remain desktop UI without a coarse pointer');
assert.equal(api.resolvePortUiMode({ coarse: false, maxTouchPoints: 0, viewportWidth: 1440, platform: 'Win32' }), 'pc');

const workflowState = api.createPortState(); workflowState.structureId = caisson.id;
const workflowSpan = workflowState.spans[0];
const pcContainer = api.ensurePortInspection(workflowSpan, caissonTargets[0]);
const blankPcPhoto = api.createPortPhoto(null, workflowSpan, { id: 'pc-blank', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
assert.equal(blankPcPhoto.component, '');
assert.equal(blankPcPhoto.inspectionItemId, null);
assert.equal(blankPcPhoto.criteriaSetId, null);
assert.equal(blankPcPhoto.sourceTargetId, null);
const blankPcUi = api.portPhotoFields(blankPcPhoto, caissonTargets);
assert.match(blankPcUi, /<option value="" selected>選択してください<\/option>/);
assert.match(blankPcUi, /data-port-photo-rating="pc-blank"[^>]*disabled/);

const commentPhoto = api.createPortPhoto(caissonTargets[0], workflowSpan, { id: 'comment-photo', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
commentPhoto.rating = 'b'; commentPhoto.ratedAt = '2026-08-23T00:00:00.000Z';
let commentUi = api.portPhotoFields(commentPhoto, caissonTargets);
let commentSelect = commentUi.match(/<select data-port-photo-comment="comment-photo"[\s\S]*?<\/select>/)?.[0] || '';
assert.doesNotMatch(commentSelect, /選択してください/);
assert.deepEqual(Array.from(commentSelect.matchAll(/<option value="(あり|なし)"/g), (match) => match[1]), ['あり', 'なし']);
assert.equal(api.portPhotoCommentComplete(commentPhoto), false);
api.setPortPhotoComment(commentPhoto, 'あり');
commentUi = api.portPhotoFields(commentPhoto, caissonTargets);
assert.doesNotMatch(commentUi.match(/<textarea data-port-photo-free-text="comment-photo"[\s\S]*?<\/textarea>/)?.[0] || '', /disabled/);
assert.equal(api.portPhotoCommentComplete(commentPhoto), false, 'あり without free text must remain incomplete');
commentPhoto.conditionFreeText = 'ひび割れあり';
assert.equal(api.portPhotoCommentComplete(commentPhoto), true, 'あり with free text must complete');
api.setPortPhotoComment(commentPhoto, 'なし');
assert.equal(commentPhoto.conditionFreeText, '', 'なし must clear existing free text');
assert.equal(api.portPhotoCommentComplete(commentPhoto), true, 'なし must not require free text');
commentUi = api.portPhotoFields(commentPhoto, caissonTargets);
assert.match(commentUi.match(/<textarea data-port-photo-free-text="comment-photo"[\s\S]*?<\/textarea>/)?.[0] || '', /disabled/);

const pcComponents = ['ケーソン', '上部工（無筋）', 'エプロン'];
const pcPhotos = pcComponents.map((component, index) => {
  const photo = api.createPortPhoto(null, workflowSpan, { id: `pc-${index + 1}`, data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
  assert.equal(api.setPortPhotoComponent(photo, component, caissonTargets).status, 'resolved');
  Object.assign(photo, { rating: ['a', 'b', 'c'][index], ratedAt: '2026-08-22T00:00:00.000Z', conditionComment: 'あり', conditionFreeText: `PC写真${index + 1}` });
  return photo;
});
pcContainer.photos.push(...pcPhotos);
api.reindexPortSpanPhotos(workflowSpan);
api.refreshPortSpanStatuses(workflowSpan, caissonTargets);
const desktopView = api.portDesktopSpanView(workflowSpan, caissonTargets);
assert.doesNotMatch(desktopView, /次の撮影対象/);
assert.match(desktopView, /JPG／JPEG／PNGをドラッグ＆ドロップ/);
assert.match(desktopView, /完了 3 \/ 7/);
assert.match(desktopView, /未完了 4/);
assert.match(desktopView, /スキップ 0/);
assert.match(desktopView, /未完了項目を確認/);
assert.match(desktopView, /<details class="port-incomplete">/);
assert.doesNotMatch(desktopView, /<details class="port-incomplete" open/);
assert.match(desktopView, /data-port-skip-target=/);
for (const [index, component] of pcComponents.entries()) {
  assert.match(desktopView, new RegExp(`data-port-photo-component="pc-${index + 1}"`));
  assert.match(desktopView, new RegExp(`<option selected>${component.replace(/[()]/g, '\\$&')}<\\/option>`));
}

const sharedState = api.createPortState(); sharedState.structureId = caisson.id;
const sharedSpan = sharedState.spans[0], sharedTarget = caissonTargets[0], sharedRecord = api.ensurePortInspection(sharedSpan, sharedTarget);
const mobilePhoto = api.createPortPhoto(sharedTarget, sharedSpan, { id: 'shared-photo', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
sharedRecord.photos.push(mobilePhoto); api.refreshPortSpanStatuses(sharedSpan, caissonTargets);
const mobileView = api.portMobileSpanView(sharedSpan, caissonTargets);
assert.doesNotMatch(mobileView, /次の撮影対象/);
assert.doesNotMatch(mobileView, /port-mobile-target/);
assert.match(mobileView, /port-mobile-capture/);
assert.match(mobileView, />写真を撮影<input[^>]*capture="environment"/);
assert.match(mobileView, /data-port-photo-component="shared-photo"/);
assert.doesNotMatch(mobileView, /同じ対象を追加撮影/, 'same-target capture must not be constantly visible');
assert.match(mobileView, />次へ<\/button>/);
assert.doesNotMatch(mobileView, />次の対象へ<\/button>/);
assert.doesNotMatch(mobileView, /ドラッグ＆ドロップ/);
Object.assign(mobilePhoto, { rating: 'b', ratedAt: '2026-08-22T01:00:00.000Z', conditionComment: 'あり', conditionFreeText: 'スマホ保存' });
api.refreshPortSpanStatuses(sharedSpan, caissonTargets);
assert.equal(api.portMobileTargetReady(sharedSpan, sharedTarget, caissonTargets), true);
assert.equal(api.openPortMobileNextActions(sharedSpan, sharedTarget, caissonTargets), true);
const mobileNextActionsView = api.portMobileSpanView(sharedSpan, caissonTargets);
assert.match(mobileNextActionsView, /次の操作を選択/);
assert.match(mobileNextActionsView, /同じ対象を追加撮影/);
assert.match(mobileNextActionsView, /新規対象を撮影/);
api.closePortMobileNextActions();
const sameTargetPhoto = api.createPortPhotoFromSource(sharedTarget, sharedSpan, mobilePhoto, { id: 'same-target-photo', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
assert.equal(sameTargetPhoto.spanId, mobilePhoto.spanId);
assert.equal(sameTargetPhoto.component, mobilePhoto.component);
assert.equal(sameTargetPhoto.inspectionItemId, mobilePhoto.inspectionItemId);
assert.equal(sameTargetPhoto.criteriaSetId, mobilePhoto.criteriaSetId);
assert.equal(sameTargetPhoto.rating, null);
assert.equal(sameTargetPhoto.conditionComment, '');
assert.equal(sameTargetPhoto.conditionFreeText, '');
assert.equal(mobilePhoto.rating, 'b', 'same-target photo creation must not change the existing photo rating');
assert.equal(mobilePhoto.conditionComment, 'あり', 'same-target photo creation must not change the existing photo comment');
assert.notEqual(api.nextIncompletePortTargetIndex(sharedSpan, caissonTargets, 0), 0, 'new-target flow must select a different incomplete inspection item');
const incompleteSameTargetPhoto = api.createPortPhoto(sharedTarget, sharedSpan, { id: 'shared-incomplete', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
sharedRecord.photos.push(incompleteSameTargetPhoto); api.reindexPortSpanPhotos(sharedSpan); api.refreshPortSpanStatuses(sharedSpan, caissonTargets);
assert.equal(api.portTargetStatus(sharedSpan, sharedTarget, caissonTargets), 'completed', 'one completed photo is enough to complete its inspection item');
assert.equal(api.portMobileTargetReady(sharedSpan, sharedTarget, caissonTargets), false, 'mobile next must wait until every newly added photo is entered');
let sharedReload = api.normalizePortState(JSON.parse(JSON.stringify(sharedState)));
let sharedReloadPhoto = api.findPortPhoto(sharedReload.spans[0], 'shared-photo').photo;
assert.equal(sharedReloadPhoto.component, sharedTarget.component);
assert.equal(sharedReloadPhoto.rating, 'b');
assert.equal(sharedReloadPhoto.conditionFreeText, 'スマホ保存');
assert.match(api.portDesktopSpanView(sharedReload.spans[0], caissonTargets), /data-port-photo-component="shared-photo"/);
assert.equal(api.setPortPhotoComponent(sharedReloadPhoto, 'エプロン', caissonTargets).status, 'resolved');
Object.assign(sharedReloadPhoto, { rating: 'c', ratedAt: '2026-08-22T02:00:00.000Z', conditionComment: 'あり', conditionFreeText: 'PC修正' });
sharedReload = api.normalizePortState(JSON.parse(JSON.stringify(sharedReload)));
sharedReloadPhoto = api.findPortPhoto(sharedReload.spans[0], 'shared-photo').photo;
assert.equal(sharedReloadPhoto.component, 'エプロン');
assert.equal(sharedReloadPhoto.rating, 'c');
assert.equal(sharedReloadPhoto.conditionFreeText, 'PC修正');
assert.equal(sharedReloadPhoto.sourceTargetId, sharedTarget.id, 'desktop edits must preserve the mobile push source without creating device-specific data');

const pushState = api.createPortState(); pushState.structureId = caisson.id;
const pushSpan = pushState.spans[0];
const firstSkip = api.ensurePortInspection(pushSpan, caissonTargets[0]); firstSkip.skipped = true; firstSkip.status = 'skipped';
const secondSkip = api.ensurePortInspection(pushSpan, caissonTargets[1]); secondSkip.skipped = true; secondSkip.status = 'skipped';
api.refreshPortSpanStatuses(pushSpan, caissonTargets);
assert.equal(api.nextIncompletePortTargetIndex(pushSpan, caissonTargets, -1), 2, 'mobile push order must skip completed or skipped targets');
assert.doesNotMatch(api.portMobileSpanView(pushSpan, caissonTargets), /次の撮影対象/);
assert.equal(pushSpan.currentTargetIndex, 2, 'mobile push logic must keep selecting the next incomplete target internally');

const navigationState = api.createPortState();
api.resizePortSpans(navigationState, 3);
navigationState.view = 'span'; navigationState.activeSpanId = navigationState.spans[1].id;
const mobileNavigation = api.portMobileNavigationView(navigationState);
assert.match(mobileNavigation, /data-port-nav="setup">施設設定/);
assert.match(mobileNavigation, /data-port-nav="summary">速報結果/);
assert.deepEqual(Array.from(mobileNavigation.matchAll(/<option value="[^"]+"[^>]*>スパン(\d+)<\/option>/g), (match) => Number(match[1])), [1, 2, 3]);
assert.match(mobileNavigation, new RegExp(`<option value="${navigationState.spans[1].id}" selected>スパン2</option>`));
navigationState.view = 'summary';
assert.match(api.portMobileNavigationView(navigationState), /<option value="">スパン選択<\/option>/, 'summary must allow returning to any span including the current span');

const spanNavigationState = api.createPortState();
spanNavigationState.structureId = caisson.id;
api.resizePortSpans(spanNavigationState, 3);
const [spanOne, spanTwo, spanThree] = spanNavigationState.spans;
assert.equal(api.setPortNavigation(spanNavigationState, 'span', spanOne.id), true);
assert.equal(api.setPortNavigation(spanNavigationState, 'span', spanTwo.id), true);
const spanTwoCapture = api.appendPortPhoto(spanNavigationState, 'mobile', spanTwo.id, caissonTargets[0].id, '', { id: 'span-two-photo', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
assert.equal(spanTwoCapture.photo.spanId, spanTwo.id);
assert.equal(api.portSpanPhotoEntries(spanTwo).length, 1);
assert.equal(api.portSpanPhotoEntries(spanOne).length, 0);
assert.equal(api.portSpanPhotoEntries(spanThree).length, 0);
assert.match(api.portMobileSpanView(spanTwo, caissonTargets), /data-port-photo-component="span-two-photo"/);
assert.doesNotMatch(api.portMobileSpanView(spanOne, caissonTargets), /span-two-photo/);
assert.equal(api.setPortNavigation(spanNavigationState, 'span', spanOne.id), true);
assert.equal(api.setPortNavigation(spanNavigationState, 'span', spanThree.id), true);
assert.equal(api.setPortNavigation(spanNavigationState, 'summary'), true);
assert.equal(api.setPortNavigation(spanNavigationState, 'span', spanTwo.id), true);
assert.equal(spanNavigationState.activeSpanId, spanTwo.id);
let spanNavigationReload = api.normalizePortState(JSON.parse(JSON.stringify(spanNavigationState)));
assert.equal(spanNavigationReload.activeSpanId, spanTwo.id);
assert.equal(api.findPortPhoto(spanNavigationReload.spans[1], 'span-two-photo').photo.spanId, spanTwo.id);
let reloadedSpanTwoPhoto = api.findPortPhoto(spanNavigationReload.spans[1], 'span-two-photo').photo;
assert.equal(api.setPortPhotoComponent(reloadedSpanTwoPhoto, 'エプロン', caissonTargets).status, 'resolved');
Object.assign(reloadedSpanTwoPhoto, { rating: 'c', ratedAt: '2026-08-23T03:00:00.000Z' });
api.setPortPhotoComment(reloadedSpanTwoPhoto, 'なし');
assert.equal(api.setPortNavigation(spanNavigationReload, 'summary'), true);
assert.equal(api.setPortNavigation(spanNavigationReload, 'span', spanOne.id), true);
assert.equal(api.setPortNavigation(spanNavigationReload, 'span', spanTwo.id), true);
assert.equal(reloadedSpanTwoPhoto.component, 'エプロン');
assert.equal(reloadedSpanTwoPhoto.rating, 'c');
assert.equal(reloadedSpanTwoPhoto.conditionComment, 'なし');
const spanTwoRecord = api.findPortPhoto(spanNavigationReload.spans[1], 'span-two-photo').record;
spanTwoRecord.photos = spanTwoRecord.photos.filter((photo) => photo.id !== 'span-two-photo');
api.reindexPortSpanPhotos(spanNavigationReload.spans[1]);
assert.equal(api.portSpanPhotoEntries(spanNavigationReload.spans[1]).length, 0);
assert.equal(api.setPortNavigation(spanNavigationReload, 'summary'), true, 'navigation must remain usable after photo deletion');

assert.equal(api.portPhotoImageProfile('mobile').maxDimension, 1024);
assert.equal(api.portPhotoImageProfile('mobile').quality, 0.68);
assert.equal(api.portPhotoImageProfile('pc').maxDimension, 1800, 'desktop photo encoding must remain unchanged');
assert.equal(api.portPhotoImageProfile('pc').quality, 0.84, 'desktop photo encoding must remain unchanged');
const quotaError = Object.assign(new Error('The quota has been exceeded'), { name: 'QuotaExceededError' });
assert.equal(api.isPortStorageQuotaError(quotaError), true);
const threeSpanStorageState = api.createPortState();
threeSpanStorageState.structureId = caisson.id;
api.resizePortSpans(threeSpanStorageState, 3);
const photoBlobMap = new Map();
const memoryPhotoStore = {
  async put(id, blob) { photoBlobMap.set(id, blob); return blob; },
  async get(id) { return photoBlobMap.get(id); },
  async delete(id) { photoBlobMap.delete(id); },
  async keys() { return [...photoBlobMap.keys()]; },
};
api.setPortPhotoStoreForTests(memoryPhotoStore);
for (const [spanIndex, span] of threeSpanStorageState.spans.entries()) for (let photoIndex = 0; photoIndex < 5; photoIndex += 1) {
  const id = `idb-span-${spanIndex + 1}-photo-${photoIndex + 1}`;
  await api.portPhotoBlobPut(id, new Blob([new Uint8Array(600000).fill(spanIndex + photoIndex + 1)], { type: 'image/jpeg' }));
  api.appendPortPhoto(threeSpanStorageState, 'mobile', span.id, caissonTargets[0].id, '', { id, mimeType: 'image/jpeg', width: 1024, height: 768 });
}
const threeSpanStorageJson = JSON.stringify(threeSpanStorageState);
assert.doesNotMatch(threeSpanStorageJson, /data:image\//, 'new photos must not store Base64 in localStorage metadata');
assert.ok(threeSpanStorageJson.length < 50000, 'localStorage metadata must not grow with 15 photo bodies');
assert.deepEqual(Array.from(threeSpanStorageState.spans, (span) => api.portSpanPhotoEntries(span).length), [5, 5, 5]);
assert.equal(photoBlobMap.size, 15, 'IndexedDB store must contain one Blob per photo');
assert.ok([...photoBlobMap.values()].every((blob) => blob instanceof Blob && blob.size === 600000));
const threeSpanReload = api.normalizePortState(JSON.parse(threeSpanStorageJson));
assert.deepEqual(Array.from(threeSpanReload.spans, (span) => api.portSpanPhotoEntries(span).length), [5, 5, 5], 'reload must restore metadata for every span');
const threeSpanHydrated = await api.portStateWithPhotoData(threeSpanReload);
assert.equal(threeSpanHydrated.spans.flatMap((span) => api.portSpanPhotoEntries(span)).filter((entry) => /^data:image\/jpeg;base64,/.test(entry.photo.data)).length, 15, 'reload must hydrate all 15 photo Blobs');
assert.equal(api.setPortNavigation(threeSpanStorageState, 'summary'), true);
assert.equal(api.setPortNavigation(threeSpanStorageState, 'span', threeSpanStorageState.spans[1].id), true);
const rollbackCandidate = api.appendPortPhoto(threeSpanStorageState, 'mobile', threeSpanStorageState.spans[1].id, caissonTargets[0].id, '', { id: 'quota-rollback', mimeType: 'image/jpeg' });
api.rollbackPortPhotos(threeSpanStorageState.spans[1], [rollbackCandidate.photo.id], caissonTargets);
assert.equal(api.portSpanPhotoEntries(threeSpanStorageState.spans[1]).length, 5, 'quota rollback must remove only the failed addition');
assert.equal(api.setPortNavigation(threeSpanStorageState, 'summary'), true, 'navigation must remain usable after quota rollback');

const legacyIdbState = api.createPortState(); legacyIdbState.structureId = caisson.id;
const legacyIdbRecord = api.ensurePortInspection(legacyIdbState.spans[0], caissonTargets[0]);
legacyIdbRecord.photos.push(
  api.createPortPhoto(caissonTargets[0], legacyIdbState.spans[0], { id: 'legacy-idb-1', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' }),
  api.createPortPhoto(caissonTargets[0], legacyIdbState.spans[0], { id: 'legacy-idb-2', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' }),
);
let migrationSaves = 0;
assert.equal(await api.migrateLegacyPortPhotos(legacyIdbState, () => { migrationSaves += 1; }), 2);
assert.equal(migrationSaves, 2, 'legacy migration must commit one photo at a time');
assert.ok(legacyIdbRecord.photos.every((photo) => !Object.hasOwn(photo, 'data')));
assert.ok((await api.portPhotoBlobGet('legacy-idb-1')) instanceof Blob);
const migratedReload = api.normalizePortState(JSON.parse(JSON.stringify(legacyIdbState)));
const migratedOutput = await api.buildPortOutputDataWithPhotos(migratedReload);
assert.match(migratedOutput.spans[0].entries[0].photos[0].photo.data, /^data:image\/jpeg;base64,/);
assert.deepEqual(Array.from(api.buildPortExcelBytes(migratedOutput).slice(0, 4)), [0x50, 0x4b, 0x03, 0x04], 'Excel must hydrate IndexedDB photos in memory');
assert.match(api.buildPortPdfHtml(migratedOutput), /data:image\/jpeg;base64,/, 'PDF must hydrate IndexedDB photos in memory');
const backupDocument = await api.createPortBackupDocument(migratedReload);
assert.match(backupDocument.data.spans[0].inspections[caissonTargets[0].id].photos[0].data, /^data:image\/jpeg;base64,/);
const restoredBackupState = api.normalizePortState(JSON.parse(JSON.stringify(backupDocument.data)));
let restoredMetadata = '';
await api.installPortBackupState(restoredBackupState, (value) => { restoredMetadata = JSON.stringify(value); }, legacyIdbState);
assert.doesNotMatch(restoredMetadata, /data:image\//, 'restore must put photo bodies in IndexedDB, not localStorage');
assert.ok((await api.portPhotoBlobGet('legacy-idb-2')) instanceof Blob);
await api.portPhotoBlobDelete('legacy-idb-1');
assert.equal(await api.portPhotoBlobGet('legacy-idb-1'), undefined, 'photo deletion must remove only its own Blob');
assert.ok((await api.portPhotoBlobGet('legacy-idb-2')) instanceof Blob, 'photo deletion must preserve other Blobs');
assert.deepEqual({ ...(await api.requestPortStoragePersistence()) }, { estimate: null, persisted: null }, 'storage estimate/persistence must be best effort');

const failedLegacyState = api.createPortState(); failedLegacyState.structureId = caisson.id;
const failedLegacyRecord = api.ensurePortInspection(failedLegacyState.spans[0], caissonTargets[0]);
failedLegacyRecord.photos.push(api.createPortPhoto(caissonTargets[0], failedLegacyState.spans[0], { id: 'legacy-fail', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' }));
api.setPortPhotoStoreForTests({ ...memoryPhotoStore, async put() { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); } });
await assert.rejects(api.migrateLegacyPortPhotos(failedLegacyState, () => {}));
assert.match(failedLegacyRecord.photos[0].data, /^data:image\//, 'failed migration must retain the old Base64 photo');
api.setPortPhotoStoreForTests(memoryPhotoStore);

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
  photo.rating = 'a'; photo.ratedAt = '2026-08-21T00:00:00.000Z'; photo.conditionComment = 'あり'; photo.conditionFreeText = '旧評価';
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
assert.match(api.portPhotoFields(fixedInitialPhoto, breakwaterTargets), /点検項目：移動/, 'a resolved photo in an ambiguous component must identify its inspection item');
const ambiguousPhoto = api.createPortPhoto(breakwaterTargets.find((candidate) => candidate.component === 'ケーソン'), { id: 'ambiguous-span' }, { id: 'ambiguous-photo' });
api.setPortPhotoComponent(ambiguousPhoto, '施設全体', breakwaterTargets);
const ambiguousPhotoUi = api.portPhotoFields(ambiguousPhoto, breakwaterTargets);
assert.match(ambiguousPhotoUi, /data-port-photo-component="ambiguous-photo"/);
assert.match(ambiguousPhotoUi, /data-port-photo-inspection-item="ambiguous-photo"/);
assert.match(ambiguousPhotoUi, /data-port-photo-rating="ambiguous-photo"[^>]*disabled/);
assert.equal(api.refreshPortInspectionStatus({ photos: [ambiguousPhoto], skipped: false }), 'photos', 'an unresolved inspection item must keep the target incomplete');
api.setPortPhotoInspectionItem(ambiguousPhoto, facilityCandidates[0].id, breakwaterTargets);
Object.assign(ambiguousPhoto, { rating: 'a', ratedAt: '2026-08-21T00:00:00.000Z', conditionComment: 'あり', conditionFreeText: '移動評価' });
assert.equal(api.portPhotoSelectionModel(ambiguousPhoto, breakwaterTargets).item.criteria.a, facilityCandidates[0].criteria.a);
api.setPortPhotoInspectionItem(ambiguousPhoto, facilityCandidates[1].id, breakwaterTargets);
assert.equal(ambiguousPhoto.rating, null, 'changing the inspection item must clear its previous rating');
assert.equal(ambiguousPhoto.conditionFreeText, '');
assert.equal(api.portPhotoSelectionModel(ambiguousPhoto, breakwaterTargets).item.criteria.a, facilityCandidates[1].criteria.a, 'criteria must follow the selected inspection item');

const ownershipState = api.createPortState(); ownershipState.structureId = caissonBreakwater.id;
const ownershipSpan = ownershipState.spans[0], ownershipSource = facilityCandidates[1], ownershipDestination = facilityCandidates[0];
const ownershipRecord = api.ensurePortInspection(ownershipSpan, ownershipSource);
const ownershipPhoto = api.createPortPhoto(ownershipSource, ownershipSpan, { id: 'ownership-photo', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
Object.assign(ownershipPhoto, { rating: 'b', ratedAt: '2026-08-23T00:00:00.000Z', conditionComment: 'なし', conditionFreeText: '' });
ownershipRecord.photos.push(ownershipPhoto);
api.setPortPhotoInspectionItem(ownershipPhoto, ownershipDestination.id, breakwaterTargets);
assert.equal(ownershipPhoto.sourceTargetId, ownershipSource.id, 'sourceTargetId remains immutable capture history');
assert.equal(api.alignPortMobileTargetToPhoto(ownershipSpan, breakwaterTargets, ownershipPhoto), breakwaterTargets.indexOf(ownershipDestination));
assert.equal(api.portMobilePhotoEntries(ownershipSpan, ownershipSource).length, 0);
assert.equal(api.portMobilePhotoEntries(ownershipSpan, ownershipDestination)[0].photo.id, ownershipPhoto.id);
assert.match(api.portMobileSpanView(ownershipSpan, breakwaterTargets), /data-port-photo-component="ownership-photo"/);
assert.match(api.portMobileSpanView(ownershipSpan, breakwaterTargets), /<option value="criteria_03_item_001" selected>移動<\/option>/);
assert.equal(api.setPortPhotoComponent(ownershipPhoto, '消波工', breakwaterTargets).status, 'choice-required');
assert.equal(api.portMobileUnresolvedPhotoEntries(ownershipSpan)[0].photo.id, ownershipPhoto.id);
assert.match(api.portMobileSpanView(ownershipSpan, breakwaterTargets), /点検項目未選択の写真/);
const waveDamageTarget = breakwaterTargets.find((target) => target.id === 'criteria_03_item_006');
api.setPortPhotoInspectionItem(ownershipPhoto, waveDamageTarget.id, breakwaterTargets);
assert.equal(api.alignPortMobileTargetToPhoto(ownershipSpan, breakwaterTargets, ownershipPhoto), breakwaterTargets.indexOf(waveDamageTarget));
assert.equal(api.portMobileUnresolvedPhotoEntries(ownershipSpan).length, 0);
assert.equal(api.portMobilePhotoEntries(ownershipSpan, waveDamageTarget)[0].photo.id, ownershipPhoto.id);
assert.match(api.portMobileSpanView(ownershipSpan, breakwaterTargets), /<option value="criteria_03_item_006" selected>損傷・欠損<\/option>/);

assert.deepEqual(Array.from(breakwaterTargets, (target) => ({
  inspectionItemId: target.id,
  component: target.component,
  diagnosisItem: target.diagnosisItem,
  classification: target.classification,
  criteriaSetId: target.criteriaSetId,
})), [
  { inspectionItemId: 'criteria_03_item_001', component: '施設全体', diagnosisItem: '移動', classification: 'Ⅰ類', criteriaSetId: 'criteria_03' },
  { inspectionItemId: 'criteria_03_item_002', component: 'ケーソン', diagnosisItem: 'コンクリートの劣化・損傷', classification: 'Ⅰ類', criteriaSetId: 'criteria_03' },
  { inspectionItemId: 'criteria_03_item_003', component: '施設全体', diagnosisItem: '沈下', classification: 'Ⅱ類', criteriaSetId: 'criteria_03' },
  { inspectionItemId: 'criteria_03_item_004', component: '上部工', diagnosisItem: 'コンクリートの劣化・損傷', classification: 'Ⅱ類', criteriaSetId: 'criteria_03' },
  { inspectionItemId: 'criteria_03_item_005', component: '消波工', diagnosisItem: '移動・散乱・沈下', classification: 'Ⅱ類', criteriaSetId: 'criteria_03' },
  { inspectionItemId: 'criteria_03_item_006', component: '消波工', diagnosisItem: '損傷・欠損', classification: 'Ⅱ類', criteriaSetId: 'criteria_03' },
], 'performance population must contain only the six items referenced by the selected structure');

function createFiveSpanBreakwaterState(ratingFor = () => 'd') {
  const state = api.createPortState(); state.facilityCategoryId = 'category_02'; state.structureId = caissonBreakwater.id;
  api.resizePortSpans(state, 5);
  for (const span of state.spans) for (const [targetIndex, target] of breakwaterTargets.entries()) {
    const record = api.ensurePortInspection(span, target);
    const photo = api.createPortPhoto(target, span, { id: `breakwater-${span.number}-${target.id}`, data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
    Object.assign(photo, { rating: ratingFor(span, target, targetIndex), ratedAt: '2026-08-23T00:00:00.000Z', conditionComment: 'なし', conditionFreeText: '' });
    record.photos.push(photo);
  }
  state.spans.forEach((span) => api.refreshPortSpanStatuses(span, breakwaterTargets));
  return state;
}

// Case A: every valid inspection item in all five spans has an a-d rating.
const breakwaterAllEntered = createFiveSpanBreakwaterState((span, target, targetIndex) => ['a', 'b', 'c', 'd'][(span.number + targetIndex) % 4]);
const outsideTarget = caissonTargets[0];
breakwaterAllEntered.spans[0].inspections[outsideTarget.id] = { inspectionItemId: outsideTarget.id, criteriaSetId: outsideTarget.criteriaSetId, component: outsideTarget.component, status: 'pending', skipped: false, photos: [] };
const breakwaterAllPerformance = api.buildPortPerformanceRatings(breakwaterAllEntered);
assert.deepEqual(Array.from(breakwaterAllPerformance.itemRatings, (row) => row.inspectionItemId), Array.from(breakwaterTargets, (target) => target.id), 'items outside the selected structure must not enter the performance population');
assert.equal(breakwaterAllPerformance.spanRepresentatives.length, 30);
assert.ok(breakwaterAllPerformance.spanRepresentatives.every((row) => row.status === 'rated'));
assert.ok(breakwaterAllPerformance.itemRatings.every((row) => row.status === 'rated' && ['A', 'B', 'C', 'D'].includes(row.rating)));
assert.ok(breakwaterAllPerformance.componentRatings.every((row) => row.status === 'rated' && ['A', 'B', 'C', 'D'].includes(row.rating)));
assert.equal(breakwaterAllPerformance.facilityStatus, 'rated');
assert.ok(['A', 'B', 'C', 'D'].includes(breakwaterAllPerformance.facilityRating));
assert.doesNotMatch(api.portPerformanceView(breakwaterAllPerformance), /判定保留/);
console.log(`caisson breakwater completed debug: ${JSON.stringify(breakwaterAllPerformance.itemRatings.map((item) => ({ inspectionItemId: item.inspectionItemId, component: item.component, diagnosisItem: item.diagnosisItem, classification: item.classification, criteriaSetId: item.criteriaSetId, spans: item.representatives.map((row) => ({ span: row.spanNumber, representative: row.rating, status: row.status })), itemRating: item.rating, itemStatus: item.status, holdReason: item.status === 'pending' ? 'required representative missing' : '' })))}`);

// Case B: all a must produce facility A under the existing classification rules.
const breakwaterAllA = createFiveSpanBreakwaterState(() => 'a');
const breakwaterAllAPerformance = api.buildPortPerformanceRatings(breakwaterAllA);
assert.ok(breakwaterAllAPerformance.itemRatings.every((row) => row.rating === 'A' && row.status === 'rated'));
assert.ok(breakwaterAllAPerformance.componentRatings.every((row) => row.rating === 'A' && row.status === 'rated'));
assert.equal(breakwaterAllAPerformance.facilityRating, 'A');
assert.equal(breakwaterAllAPerformance.facilityStatus, 'rated');

// Cases C/D: one truly unrated photo holds only its item/component/facility, then clears immediately when rated.
const heldState = createFiveSpanBreakwaterState(() => 'd');
const heldPhoto = api.findPortPhoto(heldState.spans[2], 'breakwater-3-criteria_03_item_003').photo;
heldPhoto.rating = null; heldPhoto.ratedAt = null;
let heldPerformance = api.buildPortPerformanceRatings(heldState);
let heldItem = heldPerformance.itemRatings.find((row) => row.inspectionItemId === 'criteria_03_item_003');
assert.equal(heldItem.status, 'pending');
assert.equal(heldItem.representatives.find((row) => row.spanNumber === 3).status, 'pending');
assert.equal(heldPerformance.componentRatings.find((row) => row.component === '施設全体').status, 'pending');
assert.equal(heldPerformance.facilityStatus, 'pending');
heldPhoto.rating = 'd'; heldPhoto.ratedAt = '2026-08-23T00:01:00.000Z';
heldPerformance = api.buildPortPerformanceRatings(heldState);
heldItem = heldPerformance.itemRatings.find((row) => row.inspectionItemId === 'criteria_03_item_003');
assert.equal(heldItem.rating, 'D'); assert.equal(heldItem.status, 'rated');
assert.equal(heldPerformance.componentRatings.find((row) => row.component === '施設全体').rating, 'D');
assert.equal(heldPerformance.facilityRating, 'D'); assert.equal(heldPerformance.facilityStatus, 'rated');

// Case E: an all-span skipped/non-applicable item is excluded without creating a pending rating.
const skippedState = createFiveSpanBreakwaterState(() => 'd');
for (const span of skippedState.spans) {
  const record = api.ensurePortInspection(span, breakwaterTargets[5]);
  record.photos = []; record.skipped = true; record.skipReason = '該当なし'; record.status = 'skipped';
}
const skippedPerformance = api.buildPortPerformanceRatings(skippedState);
assert.equal(skippedPerformance.itemRatings.find((row) => row.inspectionItemId === 'criteria_03_item_006').status, 'not-applicable');
assert.equal(skippedPerformance.componentRatings.find((row) => row.component === '消波工').rating, 'D');
assert.equal(skippedPerformance.facilityRating, 'D'); assert.equal(skippedPerformance.facilityStatus, 'rated');

// Case F/root-cause reproduction: sourceTargetId completion must not conceal a missing actual inspectionItemId.
const reassignedState = createFiveSpanBreakwaterState(() => 'd');
for (const span of reassignedState.spans) for (const [missingId, replacementId] of [['criteria_03_item_003', 'criteria_03_item_001'], ['criteria_03_item_006', 'criteria_03_item_005']]) {
  const photo = api.findPortPhoto(span, `breakwater-${span.number}-${missingId}`).photo;
  api.setPortPhotoComponent(photo, breakwaterTargets.find((target) => target.id === replacementId).component, breakwaterTargets);
  api.setPortPhotoInspectionItem(photo, replacementId, breakwaterTargets);
  Object.assign(photo, { rating: 'd', ratedAt: '2026-08-23T00:02:00.000Z', conditionComment: 'なし', conditionFreeText: '' });
  const sourceTarget = breakwaterTargets.find((target) => target.id === missingId);
  const replacementTarget = breakwaterTargets.find((target) => target.id === replacementId);
  assert.equal(api.portTargetStatus(span, sourceTarget, breakwaterTargets), 'pending');
  assert.equal(api.portMobileTargetReady(span, sourceTarget, breakwaterTargets), false, 'sourceTargetId alone must not complete a different inspection item');
  assert.equal(api.portTargetIncompleteReason(span, sourceTarget, breakwaterTargets), '写真を撮影するか、スキップしてください。');
  assert.equal(api.portMobilePhotoEntries(span, sourceTarget).some((entry) => entry.photo.id === photo.id), false, 'a reassigned photo must disappear from its source target display');
  assert.equal(api.portMobilePhotoEntries(span, replacementTarget).some((entry) => entry.photo.id === photo.id), true, 'a reassigned photo must appear only under its actual inspection item');
  assert.match(api.portMobileNextActionsView(photo), new RegExp(`data-port-photo-target="${replacementId}"`), 'same-target capture must follow actual inspection-item ownership');
  assert.doesNotMatch(api.portMobileNextActionsView(photo), new RegExp(`data-port-photo-target="${missingId}"`));
}
let reassignedPerformance = api.buildPortPerformanceRatings(reassignedState);
const pendingDebug = reassignedPerformance.itemRatings.filter((item) => item.status === 'pending').flatMap((item) => item.representatives.filter((row) => row.status === 'pending').map((row) => ({
  inspectionItemId: item.inspectionItemId,
  component: item.component,
  diagnosisItem: item.diagnosisItem,
  classification: item.classification,
  criteriaSetId: item.criteriaSetId,
  span: row.spanNumber,
  representative: row.rating,
  status: row.status,
  reason: row.photoCount ? 'unrated photo remains' : 'representative rating missing',
})));
assert.deepEqual([...new Set(pendingDebug.map((row) => row.inspectionItemId))], ['criteria_03_item_003', 'criteria_03_item_006']);
assert.equal(pendingDebug.length, 10);
console.log(`caisson breakwater pending debug: ${JSON.stringify(pendingDebug)}`);
for (const span of reassignedState.spans) for (const missingId of ['criteria_03_item_003', 'criteria_03_item_006']) {
  const photo = api.findPortPhoto(span, `breakwater-${span.number}-${missingId}`).photo;
  const target = breakwaterTargets.find((candidate) => candidate.id === missingId);
  api.setPortPhotoComponent(photo, target.component, breakwaterTargets);
  api.setPortPhotoInspectionItem(photo, missingId, breakwaterTargets);
  Object.assign(photo, { rating: 'd', ratedAt: '2026-08-23T00:03:00.000Z', conditionComment: 'なし', conditionFreeText: '' });
}
reassignedPerformance = api.buildPortPerformanceRatings(reassignedState);
assert.ok(reassignedPerformance.itemRatings.every((row) => row.status === 'rated' && row.rating === 'D'));
assert.ok(reassignedPerformance.componentRatings.every((row) => row.status === 'rated' && row.rating === 'D'));
assert.equal(reassignedPerformance.facilityRating, 'D'); assert.equal(reassignedPerformance.facilityStatus, 'rated');
assert.equal(reassignedPerformance.spanRepresentatives.length, 30);
assert.equal(reassignedPerformance.spanRepresentatives.filter((row) => row.status === 'pending').length, 0, 'all six items across five spans must clear every hold');

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
wallRecord.photos.push({ id: 'wall-photo', inspectionItemId: wallTarget.id, criteriaSetId: wallTarget.criteriaSetId, component: wallTarget.component, order: 1, rating: 'a', ratedAt: '2026-08-21T01:00:00.000Z', conditionComment: 'あり', conditionFreeText: '岸壁法線写真', data: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg' });
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
const completedRecord = api.ensurePortInspection(repeatedSpan, repeatedTargets[repeatedIndexes[0]]); completedRecord.status = 'skipped'; completedRecord.skipped = true;
const skippedRecord = api.ensurePortInspection(repeatedSpan, repeatedTargets[repeatedIndexes[1]]); skippedRecord.status = 'skipped'; skippedRecord.skipped = true;
assert.equal(api.selectPortComponent(repeatedSpan, repeatedTargets, repeatedComponent), repeatedIndexes[2], 'component selection must open its first incomplete target');
const repeatedProgress = api.portComponentProgress(repeatedSpan, repeatedTargets, repeatedSpan.currentTargetIndex);
assert.equal(repeatedProgress.position, 3);
assert.equal(repeatedProgress.completed, 2);
for (const index of repeatedIndexes) {
  const record = api.ensurePortInspection(repeatedSpan, repeatedTargets[index]);
  record.status = 'skipped'; record.skipped = true;
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
Object.assign(photo1, { rating: 'a', ratedAt: '2026-08-21T00:00:00.000Z', conditionComment: 'あり', conditionFreeText: 'コメントA' });
const photo2 = api.createPortPhoto(targets[0], state.spans[0], { id: 'p2', data: jpeg, order: 9, mimeType: 'image/jpeg' });
assert.equal(api.setPortPhotoComponent(photo2, 'エプロン', targets).status, 'resolved', 'a single-candidate component must resolve automatically');
Object.assign(photo2, { rating: 'c', ratedAt: '2026-08-21T00:01:00.000Z', conditionComment: 'あり', conditionFreeText: '' });
first.photos.push(photo1, photo2);
api.reindexPortPhotos(first);
assert.deepEqual(Array.from(first.photos, (photo) => photo.order), [1, 2]);
assert.equal(api.refreshPortInspectionStatus(first), 'completed', 'one completed photo completes the target even when another photo is still being entered');
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
Object.assign(first.photos[1], { rating: 'c', ratedAt: '2026-08-21T00:01:00.000Z', conditionComment: 'あり', conditionFreeText: 'コメントC' });
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
assert.equal(api.refreshPortInspectionStatus(first), 'completed');
first.photos[2].rating = 'd';
first.photos[2].ratedAt = '2026-08-21T00:02:00.000Z';
first.photos[2].conditionComment = 'あり';
first.photos[2].conditionFreeText = 'コメントD';
assert.equal(api.refreshPortInspectionStatus(first), 'completed');
const photoCardUis = first.photos.map((photo) => api.portPhotoFields(photo, targets));
for (const [index, card] of photoCardUis.entries()) {
  assert.match(card, new RegExp(`aria-label="写真${index + 1}の点検情報"`));
  assert.match(card, new RegExp(`data-port-photo-component="p${index + 1}"`), `photo ${index + 1} must show its own component selector`);
  assert.match(card, new RegExp(`data-port-photo-rating="p${index + 1}"`));
  assert.match(card, new RegExp(`data-port-photo-comment="p${index + 1}"`));
  assert.match(card, new RegExp(`data-port-photo-free-text="p${index + 1}"`));
}
assert.match(photoCardUis[0], /<option selected>岸壁法線<\/option>/);
assert.match(photoCardUis[1], /<option selected>エプロン<\/option>/);
assert.match(photoCardUis[2], /<option selected>上部工（RC）<\/option>/);
assert.doesNotMatch(photoCardUis[1], /data-port-photo-inspection-item/, 'single-candidate components must not show the inspection item selector');

const skipped = api.ensurePortInspection(state.spans[0], targets[2]);
skipped.skipped = true;
skipped.skipReason = '水中部等で撮影不可';
assert.equal(api.refreshPortInspectionStatus(skipped), 'skipped');
const summary = api.summarizePortFacility(state);
assert.equal(summary.totals.a, 1);
assert.equal(summary.totals.c, 1);
assert.equal(summary.totals.d, 1);
assert.equal(summary.totals.rated, 3, 'ratings must be counted per photo');
assert.equal(summary.totals.completed, 3, 'completion must follow each photo inspectionItemId and be counted per target');
assert.equal(summary.totals.skipped, 1);
assert.equal(summary.totals.total, 4 * targets.length);
assert.equal(summary.spans[0].a, 1);
assert.equal(summary.spans[0].c, 1);
assert.equal(summary.spans[0].d, 1);
assert.equal(summary.spans[0].skipped, 1);
assert.equal(summary.spans[0].completed, 3);
assert.equal(summary.totals.completionRate, Math.round(4 / summary.totals.total * 1000) / 10);
assert.equal(summary.details.a[0].component, '岸壁法線');
assert.equal(summary.details.a[0].diagnosisItem, '凹凸・出入り');

const matrixState = api.createPortState(); matrixState.structureId = structure.id; api.resizePortSpans(matrixState, 2);
const matrixTargets = api.portTargetsForStructure(structure.id);
const matrixWallTarget = matrixTargets.find((target) => target.component === '岸壁法線');
const matrixApronTarget = matrixTargets.find((target) => target.component === 'エプロン');
const matrixCaissonTarget = matrixTargets.find((target) => target.component === 'ケーソン');
const addMatrixPhoto = (span, ownerTarget, actualTarget, id, rating) => {
  const record = api.ensurePortInspection(span, ownerTarget);
  const photo = api.createPortPhoto(actualTarget, span, { id, data: jpeg, mimeType: 'image/jpeg' });
  Object.assign(photo, { rating, ratedAt: '2026-08-22T03:00:00.000Z', conditionComment: 'あり', conditionFreeText: `${id}コメント` });
  record.photos.push(photo);
  return photo;
};
addMatrixPhoto(matrixState.spans[0], matrixWallTarget, matrixWallTarget, 'matrix-wall-a', 'a');
addMatrixPhoto(matrixState.spans[0], matrixWallTarget, matrixApronTarget, 'matrix-apron-a', 'a');
addMatrixPhoto(matrixState.spans[0], matrixWallTarget, matrixApronTarget, 'matrix-apron-c1', 'c');
const matrixApronPhoto2 = addMatrixPhoto(matrixState.spans[0], matrixWallTarget, matrixApronTarget, 'matrix-apron-c2', 'c');
addMatrixPhoto(matrixState.spans[1], matrixWallTarget, matrixWallTarget, 'matrix-wall-b', 'b');
const matrixSkip = api.ensurePortInspection(matrixState.spans[0], matrixCaissonTarget); matrixSkip.skipped = true; matrixSkip.skipReason = '視認不可';
for (const span of matrixState.spans) { api.reindexPortSpanPhotos(span); api.refreshPortSpanStatuses(span, matrixTargets); }
let matrixSummary = api.summarizePortFacility(matrixState);
assert.deepEqual(Array.from(matrixSummary.matrix.components), Array.from(api.portComponentsForTargets(matrixTargets)), 'matrix rows must follow unique PORT_MASTER component order');
assert.deepEqual(Array.from(matrixSummary.matrix.spans, (span) => span.number), [1, 2], 'matrix columns must be span numbers');
const matrixRow = (component) => matrixSummary.matrix.rows.find((row) => row.component === component);
assert.deepEqual({ ...matrixRow('岸壁法線').cells[0].counts }, { a: 1, b: 0, c: 0, d: 0 });
assert.deepEqual({ ...matrixRow('岸壁法線').cells[1].counts }, { a: 0, b: 1, c: 0, d: 0 }, 'span 2 must not mix span 1 photos');
assert.deepEqual({ ...matrixRow('エプロン').cells[0].counts }, { a: 1, b: 0, c: 2, d: 0 }, 'same span/component ratings must retain all photo counts');
assert.equal(api.portMatrixCellText(matrixRow('エプロン').cells[0]), 'a×1 / c×2');
assert.equal(api.portMatrixCellText(matrixRow('ケーソン').cells[0]), 'S');
assert.equal(api.portMatrixCellText(matrixRow('上部工（無筋）').cells[1]), '－');
assert.equal(matrixSummary.performance.ruleAvailable, true);
assert.equal(matrixSummary.performance.componentRatings.find((row) => row.component === '岸壁法線').rating, 'A');
assert.equal(matrixSummary.performance.facilityRating, null);
assert.equal(matrixSummary.performance.facilityStatus, 'pending');
assert.deepEqual(Array.from(matrixSummary.performance.sourceSheets), ['00_使用方法', '13_評価基準']);
const matrixHtml = api.portSummaryMatrixView(matrixSummary.matrix);
assert.match(matrixHtml, /<th>部材<\/th><th>スパン1<\/th><th>スパン2<\/th>/);
assert.match(matrixHtml, /a×1/);
assert.match(matrixHtml, /a×1 \/ c×2/);
assert.match(matrixHtml, />S<\/td>/);
const performanceHtml = api.portPerformanceView(matrixSummary.performance);
assert.match(performanceHtml, /施設全体 性能低下度（一次判定）/);
assert.match(performanceHtml, /<strong>判定保留<\/strong>/);
assert.match(performanceHtml, /性能低下度は自動一次判定です/);
assert.ok(performanceHtml.indexOf('施設全体 性能低下度（一次判定）') < performanceHtml.indexOf('部材別 性能低下度（一次判定）'), 'facility performance must precede component performance');
const summaryLayoutSource = api.portSummaryView.toString();
assert.ok(summaryLayoutSource.indexOf('portPerformanceView') < summaryLayoutSource.indexOf('portSummaryMatrixView'), 'performance blocks must precede the span/component matrix');
assert.ok(summaryLayoutSource.indexOf('portSummaryMatrixView') < summaryLayoutSource.indexOf("detailsTable('スキップ箇所'"), 'matrix must precede skip details');
assert.ok(summaryLayoutSource.indexOf("detailsTable('スキップ箇所'") < summaryLayoutSource.indexOf('summaryCards'), 'individual metric cards must be the final summary block');

const representativeTarget = { id: 'representative-item' };
const representativeSpan = { id: 'representative-span', number: 1 };
const representative = (ratings, status = 'completed') => api.portSpanItemRepresentative({
  span: representativeSpan,
  target: representativeTarget,
  status,
  photos: ratings.map((rating) => ({ photo: { rating } })),
});
assert.equal(representative(['c', 'a', 'b']).rating, 'a', 'c,a,b must aggregate to representative a');
assert.equal(representative(['d', 'c']).rating, 'c', 'd,c must aggregate to representative c');
assert.equal(representative(['a', null]).status, 'pending', 'one unrated photo must keep the representative pending');
assert.equal(representative([], 'skipped').status, 'excluded', 'skipped target without photos must be excluded');

assert.equal(api.portInspectionPerformanceRating('Ⅰ類', { a: 1, b: 0, c: 0, d: 2 }), 'A');
assert.equal(api.portInspectionPerformanceRating('Ⅰ類', { a: 0, b: 1, c: 2, d: 0 }), 'B');
assert.equal(api.portInspectionPerformanceRating('Ⅰ類', { a: 0, b: 0, c: 1, d: 2 }), 'C');
assert.equal(api.portInspectionPerformanceRating('Ⅰ類', { a: 0, b: 0, c: 0, d: 3 }), 'D');
assert.equal(api.portInspectionPerformanceRating('Ⅱ類', { a: 5, b: 0, c: 5, d: 0 }), 'A', '50% a boundary must be A');
assert.equal(api.portInspectionPerformanceRating('Ⅱ類', { a: 0, b: 8, c: 2, d: 0 }), 'A', '80% a+b boundary must be A');
assert.equal(api.portInspectionPerformanceRating('Ⅱ類', { a: 1, b: 0, c: 9, d: 0 }), 'B');
assert.equal(api.portInspectionPerformanceRating('Ⅱ類', { a: 0, b: 5, c: 5, d: 0 }), 'B', '50% a+b boundary must be B when A is false');
assert.equal(api.portInspectionPerformanceRating('Ⅱ類', { a: 0, b: 0, c: 2, d: 8 }), 'C');
assert.equal(api.portInspectionPerformanceRating('Ⅱ類', { a: 0, b: 0, c: 0, d: 10 }), 'D');
assert.equal(api.portInspectionPerformanceRating('Ⅲ類', { a: 1, b: 0, c: 0, d: 1 }), 'C', 'class III must not auto-rate A/B');
assert.equal(api.portInspectionPerformanceRating('Ⅲ類', { a: 0, b: 0, c: 0, d: 2 }), 'D');

const performanceSpans = [{ id: 'performance-span-1', number: 1 }, { id: 'performance-span-2', number: 2 }];
const performanceTargets = [
  { id: 'performance-i', criteriaSetId: 'set-i', component: '共通部材', diagnosisItem: 'Ⅰ類項目', classification: 'Ⅰ類' },
  { id: 'performance-iii', criteriaSetId: 'set-iii', component: '共通部材', diagnosisItem: 'Ⅲ類項目', classification: 'Ⅲ類' },
  { id: 'performance-ii', criteriaSetId: 'set-ii', component: '別部材', diagnosisItem: 'Ⅱ類項目', classification: 'Ⅱ類' },
  { id: 'performance-skip', criteriaSetId: 'set-skip', component: '除外部材', diagnosisItem: '除外項目', classification: 'Ⅰ類' },
];
const performancePhoto = (rating) => ({ photo: { rating } });
const performanceTargetResults = [
  { span: performanceSpans[0], target: performanceTargets[0], status: 'completed', photos: ['c', 'a', 'b'].map(performancePhoto) },
  { span: performanceSpans[1], target: performanceTargets[0], status: 'completed', photos: ['d'].map(performancePhoto) },
  { span: performanceSpans[0], target: performanceTargets[1], status: 'completed', photos: ['d'].map(performancePhoto) },
  { span: performanceSpans[1], target: performanceTargets[1], status: 'completed', photos: ['d'].map(performancePhoto) },
  { span: performanceSpans[0], target: performanceTargets[2], status: 'completed', photos: ['b'].map(performancePhoto) },
  { span: performanceSpans[1], target: performanceTargets[2], status: 'completed', photos: ['c'].map(performancePhoto) },
  { span: performanceSpans[0], target: performanceTargets[3], status: 'skipped', photos: [] },
  { span: performanceSpans[1], target: performanceTargets[3], status: 'skipped', photos: [] },
];
const performanceCollected = { targets: performanceTargets, targetResults: performanceTargetResults, photoResults: [] };
const photoRatingSnapshot = performanceTargetResults.flatMap((row) => row.photos.map((entry) => entry.photo.rating));
let performance = api.buildPortPerformanceRatings({ spans: performanceSpans }, performanceCollected);
assert.equal(performance.itemRatings.find((item) => item.inspectionItemId === 'performance-i').rating, 'A');
assert.equal(performance.itemRatings.find((item) => item.inspectionItemId === 'performance-iii').rating, 'D');
assert.equal(performance.itemRatings.find((item) => item.inspectionItemId === 'performance-ii').rating, 'B');
assert.equal(performance.itemRatings.find((item) => item.inspectionItemId === 'performance-skip').status, 'not-applicable');
assert.equal(performance.componentRatings.find((row) => row.component === '共通部材').rating, 'A', 'component must use strictest item A-D');
assert.equal(performance.componentRatings.find((row) => row.component === '別部材').rating, 'B');
assert.equal(performance.componentRatings.find((row) => row.component === '除外部材').status, 'not-applicable');
assert.equal(performance.facilityRating, 'A', 'facility must use strictest item A-D');
assert.equal(performance.facilityStatus, 'rated');
assert.deepEqual(performanceTargetResults.flatMap((row) => row.photos.map((entry) => entry.photo.rating)), photoRatingSnapshot, 'performance aggregation must not mutate photo ratings');
performanceTargetResults.find((row) => row.target.id === 'performance-ii').photos.push(performancePhoto(null));
performance = api.buildPortPerformanceRatings({ spans: performanceSpans }, performanceCollected);
assert.equal(performance.itemRatings.find((item) => item.inspectionItemId === 'performance-ii').status, 'pending');
assert.equal(performance.componentRatings.find((row) => row.component === '別部材').status, 'pending');
assert.equal(performance.facilityStatus, 'pending', 'one pending item must hold the facility rating');
assert.equal(performance.facilityRating, null);
performanceTargetResults.find((row) => row.target.id === 'performance-ii').photos.pop();

assert.equal(api.setPortPhotoComponent(matrixApronPhoto2, '上部工（RC）', matrixTargets).status, 'resolved');
Object.assign(matrixApronPhoto2, { rating: 'd', ratedAt: '2026-08-22T04:00:00.000Z', conditionComment: 'あり', conditionFreeText: '部材変更後' });
matrixSummary = api.summarizePortFacility(matrixState);
assert.deepEqual({ ...matrixSummary.matrix.rows.find((row) => row.component === 'エプロン').cells[0].counts }, { a: 1, b: 0, c: 1, d: 0 }, 'component change must recalculate the matrix');
assert.equal(matrixSummary.matrix.rows.find((row) => row.component === '上部工（RC）').cells[0].counts.d, 1);
const matrixOwner = api.findPortPhoto(matrixState.spans[0], 'matrix-apron-c1').record;
matrixOwner.photos = matrixOwner.photos.filter((photo) => photo.id !== 'matrix-apron-c1');
matrixSummary = api.summarizePortFacility(matrixState);
assert.deepEqual({ ...matrixSummary.matrix.rows.find((row) => row.component === 'エプロン').cells[0].counts }, { a: 1, b: 0, c: 0, d: 0 }, 'photo deletion must recalculate the matrix');

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
assert.ok(migrated.photos.every((photo) => photo.conditionComment === 'あり'), 'legacy その他 comments must migrate safely to あり');
assert.ok(!Object.hasOwn(migrated, 'rating') && !Object.hasOwn(migrated, 'conditionComment'), 'legacy target fields must not remain in new saves');
assert.equal(migrated.status, 'completed');

const output = api.buildPortOutputData(state);
assert.equal(output.summary.performance.ruleAvailable, true, 'Excel/PDF共通出力データ must use the common performance-rating result');
assert.equal(output.summary.performance.facilityStatus, 'pending');
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
assert.match(summaryXml, /部材別 性能低下度（一次判定）/);
assert.match(summaryXml, /施設全体 性能低下度（一次判定）/);
assert.match(summaryXml, /判定保留/);
for (const expected of ['岸壁法線', 'エプロン', '上部工（RC）', '凹凸・出入り', '沈下・陥没', 'コンクリートの劣化・損傷', 'コメントA', 'コメントC', 'コメントD', '>a<', '>c<', '>d<']) assert.ok(photoXml.includes(expected), `Excel missing ${expected}`);
const pdfHtml = api.buildPortPdfHtml(output);
assert.match(pdfHtml, /点検診断・a～d評価集計/);
assert.match(pdfHtml, /スパン1 写真帳/);
assert.match(pdfHtml, /スキップ記録/);
assert.match(pdfHtml, /部材別 性能低下度（一次判定）/);
assert.match(pdfHtml, /施設全体 性能低下度（一次判定）/);
assert.match(pdfHtml, /性能低下度は自動一次判定です/);
for (const expected of ['岸壁法線', 'エプロン', '上部工（RC）', '凹凸・出入り', '沈下・陥没', 'コンクリートの劣化・損傷', '評価 a', '評価 c', '評価 d', 'コメントA', 'コメントC', 'コメントD']) assert.ok(pdfHtml.includes(expected), `PDF missing ${expected}`);

const completedState = api.createPortState(); completedState.structureId = structure.id; api.resizePortSpans(completedState, 2);
const completedTargets = api.portTargetsForStructure(structure.id);
for (const span of completedState.spans) for (const [targetIndex, target] of completedTargets.entries()) {
  const record = api.ensurePortInspection(span, target);
  const rating = span.number === 1 && targetIndex === 0 ? 'a' : 'd';
  const photo = api.createPortPhoto(target, span, { id: `completed-${span.number}-${targetIndex}`, data: jpeg, mimeType: 'image/jpeg' });
  Object.assign(photo, { rating, ratedAt: '2026-08-23T00:00:00.000Z', conditionComment: 'あり', conditionFreeText: '完了確認' });
  record.photos.push(photo); api.refreshPortInspectionStatus(record, completedTargets);
}
const completedOutput = api.buildPortOutputData(completedState);
assert.equal(completedOutput.summary.performance.itemRatings.every((item) => item.status === 'rated'), true);
assert.equal(completedOutput.summary.performance.componentRatings.find((row) => row.component === '岸壁法線').rating, 'A');
assert.equal(completedOutput.summary.performance.facilityRating, 'A');
assert.equal(completedOutput.summary.performance.facilityStatus, 'rated');
const completedExcelEntries = storedZipEntries(api.buildPortExcelBytes(completedOutput));
const completedSummaryXml = new TextDecoder().decode(completedExcelEntries.get('xl/worksheets/sheet1.xml'));
assert.match(completedSummaryXml, /施設全体 性能低下度（一次判定）/);
assert.match(completedSummaryXml, /<t xml:space="preserve">A<\/t>/, 'Excel must contain the common facility A rating');
const completedPdfHtml = api.buildPortPdfHtml(completedOutput);
assert.match(completedPdfHtml, /施設全体 性能低下度（一次判定） <strong>A<\/strong>/, 'PDF must contain the common facility A rating');
api.closePortMobileNextActions();
assert.match(api.portMobileSpanView(completedState.spans[0], completedTargets), /このスパンの点検対象はすべて完了しました/);

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
assert.doesNotMatch(source, /次の撮影対象/);
assert.match(source, /function portMobileNavigationView/);
assert.match(source, /data-port-mobile-span/);
assert.match(source, /actual\.join\('\|'\)!==expected\.join\('\|'\)/, 'mobile navigation DOM must only rebuild when the span list changes');
assert.match(source, /data-port-nav="setup">施設設定/);
assert.match(source, /data-port-nav="summary">速報結果/);
assert.match(source, /portState\.activeSpanId=spanId;portState\.view='span'/);
assert.match(source, /未完了項目を確認/);
assert.match(source, /portUiMode==='mobile'\?portMobileSpanView/);
assert.match(source, /capture="environment"/);
assert.match(source, /data-port-photo-span="\$\{span\.id\}" data-port-photo-target="\$\{target\.id\}"/);
assert.match(source, /appendPortPhoto\(portState,portUiMode,captureSpanId,captureTargetId/);
assert.match(source, /portState\.activeSpanId=captureSpanId;portState\.view='span'/);
assert.match(source, /portPhotoImageProfile\(portUiMode\)/);
assert.match(source, /rollbackPortPhotos\(captureSpan,addedPhotoIds,targets\)/);
assert.match(source, /写真を保存できませんでした。端末の保存容量を確認してください。/);
assert.match(source, /PORT_PHOTO_DB_NAME='ijikannri-port-photos-v1'/);
assert.match(source, /PORT_PHOTO_STORE='photos'/);
assert.match(source, /objectStore\(PORT_PHOTO_STORE\)\.put\(blob,photoId\)/);
assert.match(source, /canvas\.toBlob/);
assert.match(source, /await portPhotoBlobPut\(photoId,converted\.blob\)/);
assert.doesNotMatch(source.match(/async function addPortPhotos[\s\S]*?\nfunction advancePort/)?.[0] || '', /data:converted\.data/);
assert.match(source, /async function migrateLegacyPortPhotos/);
assert.match(source, /delete photo\.data;saveState\(\)/);
assert.match(source, /async function buildPortOutputDataWithPhotos/);
assert.match(source, /async function createPortBackupDocument/);
assert.match(source, /navigator\?\.storage\?\.estimate/);
assert.match(source, /navigator\?\.storage\?\.persist/);
assert.match(source, /PORT_COMMENT_VALUES=\['あり','なし'\]/);
assert.match(source, /data-port-photo-source/);
assert.match(source, /data-port-action="new-target"/);
assert.match(source, />次へ<\/button>/);
assert.doesNotMatch(source, />次の対象へ<\/button>/);
assert.match(index, /\.port-ui-mobile \.port-photos\{grid-template-columns:1fr\}/);
assert.match(index, /\.port-mobile-nav-wrap\{display:none\}/);
assert.match(index, /\.port-ui-mobile \.port-mobile-nav-wrap\{display:block;position:sticky/);
assert.match(index, /\.port-ui-mobile #port-nav\{display:none\}/);
assert.match(index, /\.port-ui-pc #port-nav\{position:static;display:grid/);
assert.match(index, /\.port-ui-mobile \.port-card \.primary,\.port-ui-mobile \.port-next \.primary\{background:#17643b;color:#fff\}/);
assert.match(index, /\.port-ui-mobile \.port-card \.primary:hover,[^}]+\{background:#145a35;color:#fff\}/);
assert.match(index, /\.port-ui-mobile \.port-card \.primary:active,[^}]+\{background:#0f472a;color:#fff\}/);
assert.match(index, /\.port-ui-mobile \.port-card \.primary:disabled,[^}]+\{background:#607a69;color:#fff;opacity:1;cursor:not-allowed\}/);
assert.ok(index.lastIndexOf('.port-ui-mobile .port-card .primary') > index.indexOf('.port-form label,.port-card label'), 'mobile contrast override must follow the generic green label color');
assert.match(source, /function buildPortSummaryMatrix/);
assert.match(source, /sourceSheets:\['00_使用方法','13_評価基準'\]/);
assert.match(source, /function portSpanItemRepresentative/);
assert.match(source, /function portInspectionPerformanceRating/);
assert.match(source, /thresholds:\{majority:\.5,almost:\.8\}/);
assert.match(source, /スパン別・部材別 a～d判定/);
assert.match(source, /部材別 性能低下度/);
assert.doesNotMatch(source, /判定規則未設定/);
assert.doesNotMatch(source, /detailsTable\('a判定写真'/);
assert.doesNotMatch(source, /detailsTable\('未評価箇所'/);
assert.match(index, /\.port-summary-matrix\{overflow-x:auto/);
assert.match(index, /\.port-summary-matrix th:first-child\{position:sticky;left:0/);
assert.match(source, /new URL\(location\.href\)\.searchParams\.get\('ui'\)/);
assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*ui/i);
assert.match(index, /appMode:'fishery'/);
assert.match(index, /restoredMode=doc\.appMode\|\|'fishery'/);
assert.match(index, /if\(__startupMode!=='port'\)\{try\{const x=JSON\.parse\(localStorage\.getItem\(KEY\)\)/);
assert.match(source, /function savePort\(\).*localStorage\.setItem\(PORT_KEY/s);
assert.doesNotMatch(source, /localStorage\.setItem\(FISHERY_KEY/);
assert.match(source, /if\(mode!=='port'\)throw Error\('漁港またはモード不明のバックアップは港湾モードへ復元できません'\)/);

console.log('port rebuild static tests: OK');
