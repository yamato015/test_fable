/* Run with node tools/test_ride_updates.cjs. No packages or network required.
 * Executes the production functions in a small DOM/geolocation fixture, with a
 * controlled clock and delayed responses. Browser layout is checked separately.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source section: ${start}`);
  return source.slice(a, b);
}
class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.attrs = {}; this.events = {};
    this.style = { setProperty() {} }; this.value = ''; this.disabled = false;
    this._text = ''; this.writes = 0;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: n => classes.has(n),
      toggle: (n, force = !classes.has(n)) => { force ? classes.add(n) : classes.delete(n); return force; }
    };
  }
  set textContent(value) { this._text = value; this.writes++; }
  get textContent() { return this._text; }
  set innerHTML(value) { this.children = []; this._text = value; }
  setAttribute(name, value) { this.attrs[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.events[name] = listener; }
  querySelector() { return this.children[0]?.children[0] || null; }
  focus() { this.focused = true; }
}
function fixture() {
  const nodes = new Map(), clock = { now: 1000000 }, requests = [], watches = [], events = {}, calls = [];
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const embedded = [
    { name: 'A', lat: 35, lng: 139, lines: ['Alpha', 'Beta'] },
    { name: 'B', lat: 35.01, lng: 139, lines: ['Alpha', 'Beta'] },
    { name: 'C', lat: 35.02, lng: 139, lines: ['Gamma'] }
  ];
  const context = vm.createContext({
    console: { warn() {} }, Date: class extends Date { static now() { return clock.now; } },
    window: { STATIONS: embedded },
    document: { visibilityState: 'visible', addEventListener: (n,f) => events[n] = f,
      createElement: () => new Element(), querySelector: () => null },
    navigator: { language: 'ja', geolocation: {
      watchPosition: (ok, fail, options) => { watches.push({ok, fail, options}); return watches.length; },
      clearWatch() {}, getCurrentPosition: (ok, fail, options) => requests.push({ok, fail, options})
    } },
    localStorage: { getItem: () => 'ja' }, setInterval() {}, $, 
    syncDestMapPosition() {}, renderLineFilter() {}, showError: text => calls.push(['error', text]),
    renderLineChips() {}, renderTransferButton() {}, recordHistory() {}, renderNextStation() {},
    renderAlertProgress() {}, flashPop() {}, nearbyItem: () => new Element(),
    checkAlert: (lat,lon) => calls.push(['alert',lat,lon]),
    showToast: text => calls.push(['toast',text]),
    fetch: () => { throw new Error('Unexpected network access'); },
  });
  const run = js => vm.runInContext(js, context);
  run(section('"use strict";', '// ---- DOM ----'));
  run(`const stationName=$('station-name'),stationKana=$('station-kana'),distanceEl=$('distance'),
    statusLabel=$('status-label'),gpsStatus=$('gps-status'),updatedAt=$('updated-at'),
    nearbyList=$('nearby-list'),nextStationEl=$('next-station');`);
  run(section('const STRINGS = {', 'function updateHeaderUI()'));
  run(section('function startLocationWatch()', '$("wakelock-btn").addEventListener'));
  run(section('async function onPosition(pos)', 'function renderLineFilter()'));
  run(section('function visibleStations()', 'function nearbyItem(s)'));
  run(section('function haversine(', '// 2点間の方位角'));
  // Direction calculation itself is unchanged and outside the behaviors under test.
  run('updateHeading = () => {}; locationActive = true; stations = EMBEDDED_STATIONS; usingEmbedded = true;');
  const fix = (lat = 35, lon = 139, timestamp = clock.now, accuracy = 20, speed = 0) =>
    ({ coords: { latitude:lat, longitude:lon, accuracy, speed, heading:null }, timestamp });
  return { context, run, clock, requests, watches, events, nodes, $, fix, calls };
}
const tests = [];
const test = (name, work) => tests.push({name, work});

test('older and duplicate fixes cannot roll back the station, age or alerts', async () => {
  const f=fixture(); await f.context.onPosition(f.fix());
  f.clock.now+=10000; await f.context.onPosition(f.fix(35.01));
  const before=f.calls.length;
  assert.equal(await f.context.onPosition(f.fix(35.02,139,f.clock.now-5000)), false);
  assert.equal(await f.context.onPosition(f.fix(35.02)), false);
  assert.equal(f.$('station-name').textContent,'B');
  assert.equal(f.run('lastFixAt'),f.clock.now); assert.equal(f.calls.length,before);
});
test('a delayed station lookup cannot paint over a newer fix', async () => {
  const f=fixture(); let release;
  f.context.selectStationSource=(lat)=>lat===35 ? new Promise(r=>release=r) : Promise.resolve();
  const old=f.context.onPosition(f.fix()); f.clock.now+=1000;
  await f.context.onPosition(f.fix(35.01)); release(); assert.equal(await old,false);
  assert.equal(f.$('station-name').textContent,'B');
  assert.equal(f.calls.filter(c=>c[0]==='alert').length,1);
});
test('an outside-region response is discarded after returning to embedded coverage', async () => {
  const f=fixture(); let release;
  f.context.fetch=()=>new Promise(resolve=>release=resolve);
  const old=f.context.onPosition(f.fix(40,140)); f.clock.now+=1000;
  await f.context.onPosition(f.fix());
  release({ok:true,json:async()=>({elements:[{type:'node',id:1,lat:40,lon:140,tags:{name:'Old region'}}]})});
  await old;
  assert.equal(f.run('usingEmbedded'),true); assert.equal(f.$('station-name').textContent,'A');
  assert.equal(f.run('stations[0].name'),'A');
});
test('concurrent outside fixes share a lookup and refetch for the newest distant region', async () => {
  const f=fixture(), pending=[];
  f.context.fetch=()=>new Promise(resolve=>pending.push(resolve));
  const first=f.context.onPosition(f.fix(40,140)); f.clock.now+=1000;
  const second=f.context.onPosition(f.fix(41,141));
  assert.equal(pending.length,1);
  pending[0]({ok:true,json:async()=>({elements:[{type:'node',lat:40,lon:140,tags:{name:'Old'}}]})});
  await first;
  assert.equal(pending.length,2);
  pending[1]({ok:true,json:async()=>({elements:[{type:'node',lat:41,lon:141,tags:{name:'New'}}]})});
  await second; assert.equal(f.$('station-name').textContent,'New');
});
test('stale fixes display their real age and do not fire arrival alerts', async () => {
  const f=fixture(); await f.context.onPosition(f.fix(35,139,f.clock.now-40000));
  assert.equal(f.calls.length,0);
  assert.match(f.$('updated-at').textContent,/40/);
  assert.equal(f.$('r-status').textContent,'前回取得した位置の駅');
});
test('freshness is identical in both modes, with stable DOM when text is unchanged', async () => {
  const f=fixture(); await f.context.onPosition(f.fix()); f.clock.now+=31000;
  f.context.renderFreshness();
  assert.equal(f.$('updated-at').textContent,f.$('r-updated-at').textContent);
  assert.equal(f.$('r-updated-at').classList.contains('is-stale'),true);
  assert.equal(f.$('status-label').textContent,'前回取得した位置の駅');
  const writes=f.$('r-status').writes; f.context.renderFreshness();
  assert.equal(f.$('r-status').writes,writes);
  f.clock.now+=1000; await f.context.onPosition(f.fix());
  assert.equal(f.$('r-updated-at').classList.contains('is-stale'),false);
  assert.equal(f.$('r-location-note').classList.contains('hidden'),true);
});
test('automatic fallback waits 30s, deduplicates manual/visibility requests and backs off 30/60/120s', async () => {
  const f=fixture(); f.context.startLocationWatch(); await f.context.onPosition(f.fix());
  f.clock.now+=29999; f.context.tickLocationFreshness(); assert.equal(f.requests.length,0);
  f.clock.now++; f.context.tickLocationFreshness(); assert.equal(f.requests.length,1);
  f.context.refreshPosition(); f.events.visibilitychange(); assert.equal(f.requests.length,1);
  assert.equal(f.$('r-refresh-btn').disabled,true);
  for (const delay of [30000,60000,120000,120000]) {
    f.requests.at(-1).fail({code:3});
    assert.equal(f.run('nextAutoRefreshAt')-f.clock.now,delay);
    const count=f.requests.length;
    f.clock.now+=delay-1; f.context.tickLocationFreshness(); assert.equal(f.requests.length,count);
    f.clock.now++; f.context.tickLocationFreshness(); assert.equal(f.requests.length,count+1);
  }
  f.clock.now++; await f.requests.at(-1).ok(f.fix());
  assert.equal(f.run('refreshFailures'),0); assert.equal(f.run('nextAutoRefreshAt')-f.clock.now,30000);
  assert.equal(f.$('r-refresh-btn').disabled,false);
});
test('an old manual result cannot reset freshness or cause an immediate retry loop', async () => {
  const f=fixture(); await f.context.onPosition(f.fix()); f.clock.now+=40000;
  f.context.refreshPosition(); await f.requests[0].ok(f.fix(35,139,f.clock.now-40000));
  assert.equal(f.run('lastFixAt'),f.clock.now-40000);
  assert.equal(f.run('nextAutoRefreshAt')-f.clock.now,30000);
});
test('permission denial stops automatic retries and manual retry restarts the watch', async () => {
  const f=fixture(); await f.context.onPosition(f.fix()); f.context.onGeoError({code:1});
  f.clock.now+=200000; f.context.tickLocationFreshness(); f.events.visibilitychange();
  assert.equal(f.requests.length,0); assert.equal(f.$('r-location-note').textContent,f.run('t("gpsDenied")'));
  f.context.refreshPosition(); assert.equal(f.watches.length,1);
  assert.equal(f.run('permissionDenied'),false);
});
test('revoking permission invalidates a fix still waiting for station data', async () => {
  const f=fixture(); let release;
  f.context.selectStationSource=()=>new Promise(resolve=>release=resolve);
  const pending=f.context.onPosition(f.fix());
  f.context.onGeoError({code:1}); release();
  assert.equal(await pending,false);
  assert.equal(f.run('geoState'),'permission-denied');
  assert.equal(f.run('permissionDenied'),true);
  assert.equal(f.run('lastFixAt'),0);
});
test('a watch success during a manual request survives that request timing out', async () => {
  const f=fixture(); await f.context.onPosition(f.fix()); f.context.refreshPosition();
  f.clock.now+=1000; await f.context.onPosition(f.fix());
  f.requests[0].fail({code:3}); assert.equal(f.run('geoState'),'success');
  assert.equal(f.run('refreshFailures'),0);
});
test('hidden documents do not poll; returning requests only once', async () => {
  const f=fixture(); await f.context.onPosition(f.fix());
  f.context.document.visibilityState='hidden'; f.clock.now+=60000;
  f.context.tickLocationFreshness(); assert.equal(f.requests.length,0);
  f.context.document.visibilityState='visible'; f.events.visibilitychange(); f.events.visibilitychange();
  assert.equal(f.requests.length,1);
});
test('selected route survives low accuracy, stale fixes and fast passes', async () => {
  const f=fixture(); f.context.setRideLine('Alpha');
  for (const [accuracy,speed,age] of [[500,0,0],[20,20,0],[20,0,20000]]) {
    for (let i=0;i<4;i++) { f.clock.now+=6000; f.context.observeRideStation(35.02,139,accuracy,speed,f.clock.now-age); }
    assert.equal(f.run('rideChangeCandidate'),null); assert.equal(f.run('rideLineSource'),'user');
    assert.equal(f.run('[...rideLines][0]'),'Alpha');
  }
});
test('three good observations over 10s suggest a change without overwriting the selected line', async () => {
  const f=fixture(); f.context.setRideLine('Alpha');
  for(let i=0;i<3;i++){ f.clock.now+=5000; await f.context.onPosition(f.fix(35.02)); }
  assert.equal(f.run('[...rideLines][0]'),'Alpha');
  assert.equal(f.$('ride-ask-title').textContent,f.run('t("rideChangeTitle")'));
  assert.equal(f.$('ride-ask').classList.contains('hidden'),false);
  f.clock.now+=5000; await f.context.onPosition(f.fix());
  assert.equal(f.run('rideChangeCandidate'),null);
  assert.equal(f.$('ride-ask').classList.contains('hidden'),true);
});
test('rendering and language changes cannot count as additional route observations', async () => {
  const f=fixture(); f.context.setRideLine('Alpha'); await f.context.onPosition(f.fix(35.02));
  f.clock.now+=20000; for(let i=0;i<10;i++) f.context.render(35.02,139);
  assert.equal(f.run('rideChangeCandidate'),null); assert.equal(f.run('rideMismatch.count'),1);
});
test('Not now suppresses questions across stations; the manual entry remains available', async () => {
  const f=fixture(); await f.context.onPosition(f.fix());
  const choices=f.$('ride-ask-choices').children[0];
  f.context.render(35,139); assert.equal(f.$('ride-ask-choices').children[0],choices);
  f.$('ride-ask-later').events.click(); f.clock.now+=6000;
  await f.context.onPosition(f.fix(35.01));
  assert.equal(f.$('ride-ask').classList.contains('hidden'),true);
  assert.equal(f.$('ride-select-btn').disabled,false);
  f.$('ride-select-btn').events.click(); assert.equal(f.$('ride-ask').classList.contains('hidden'),false);
  f.$('ride-ask-choices').children[0].children[0].events.click();
  assert.equal(f.run('rideLineSource'),'user'); assert.match(f.$('ride-chip-text').textContent,/選択中/);
});
test('single-line inference remains estimated in Japanese and English', async () => {
  const f=fixture(); await f.context.onPosition(f.fix(35.02));
  assert.match(f.$('ride-chip-text').textContent,/推定/);
  f.run('lang="en"; renderRideChip(); renderFreshness();');
  assert.match(f.$('ride-chip-text').textContent,/Estimated/);
  f.context.setRideLine('Gamma'); assert.match(f.$('ride-chip-text').textContent,/Selected/);
  for (const key of ['rideSelect','rideSelectChange','rideChangeTitle','rideChangeHint','locationWaiting','locationAgeHint','locationApproximate','lastLocation']) {
    assert.equal(f.run(`Object.hasOwn(STRINGS.ja, '${key}') && Object.hasOwn(STRINGS.en, '${key}')`),true);
  }
});
test('an empty station response clears the previous riding station and manual entry', async () => {
  const f=fixture(); await f.context.onPosition(f.fix());
  f.run('stations=[]; render(40,140)');
  assert.equal(f.$('r-station').textContent,'---');
  assert.equal(f.run('lastRenderedStation'),null); assert.equal(f.$('ride-select-btn').disabled,true);
});
(async()=>{
  let passed=0;
  for(const {name,work} of tests){
    try{await work(); console.log(`PASS ${name}`); passed++;}
    catch(error){console.error(`FAIL ${name}`);console.error(error);process.exitCode=1;}
  }
  console.log(`${passed}/${tests.length} checks passed`);
})();
