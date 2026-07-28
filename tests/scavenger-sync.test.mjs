import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageSource = fs.readFileSync(path.join(repo, 'scavenger-storage.js'), 'utf8');
const safetySource = fs.readFileSync(path.join(repo, 'scavenger-sync-safety.js'), 'utf8');
const stateKey = 'star-search-offline-v1';

const task = (id, text) => ({ id, text });
const plan = ids => ({
  eligibleTaskIds: ids.slice(),
  selectedTaskIds: [],
  completedTaskIds: [],
  reshuffles: 0,
  hintRevealed: false,
  adminOverride: false,
});
const round = (id, athleteId = null) => {
  const tasks = [
    task(`${id}-task-1`, 'Task one'),
    task(`${id}-task-2`, 'Task two'),
    task(`${id}-task-3`, 'Task three'),
  ];
  return {
    id,
    title: 'Round one',
    clue: 'Look near the safe mat.',
    tasks: tasks.map(item => item.text),
    taskPool: tasks,
    taskSetsGenerated: false,
    studentTasks: athleteId ? { [athleteId]: plan(tasks.map(item => item.id)) } : {},
    eligibilityTemplates: [],
    athleteTaskTemplates: [],
    selectedTaskIds: [],
    completedTaskIds: [],
    reshuffles: 0,
  };
};

const fixtureState = () => {
  const athleteId = 'athlete-1';
  return {
    schemaVersion: 5,
    mode: 'admin',
    campName: 'Gymnastics Scavenger Hunt',
    classes: [{
      id: 'class-1',
      name: 'Camp Explorers',
      athletes: [{ id: athleteId, name: 'Avery' }],
      events: [{
        id: 'event-1',
        name: 'Floor',
        hunts: [{
          id: 'hunt-1',
          title: 'Floor day one',
          objectName: 'yellow star',
          coachLocation: '',
          roundDuration: 10,
          pointValue: 1,
          status: 'draft',
          rounds: [round('round-1', athleteId)],
          revealedRoundIds: [],
          completions: {},
          assignments: {},
          winner: null,
        }],
      }],
    }],
    lessonTemplates: [{
      id: 'lesson-1',
      title: 'Floor lesson',
      eventName: 'Floor',
      rounds: [round('lesson-round-1')],
    }],
  };
};

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.reads = [];
    this.writes = [];
  }

  getItem(key) {
    this.reads.push(key);
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.writes.push(key);
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.writes.push(key);
    this.values.delete(key);
  }
}

class MiniEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(item => item !== listener));
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
}

class TestCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

const makeHarness = initial => {
  const localStorage = new MemoryStorage(initial);
  const root = new MiniEventTarget();
  Object.assign(root, {
    localStorage,
    navigator: {
      locks: {
        request(_name, _options, callback) {
          return Promise.resolve().then(callback);
        },
      },
    },
    crypto: webcrypto,
  });
  root.window = root;
  const context = vm.createContext({
    window: root,
    CustomEvent: TestCustomEvent,
    TextEncoder,
    URL,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(storageSource, context, { filename: 'scavenger-storage.js' });
  return { store: root.ScavengerStore, localStorage, root };
};

const tests = [];
const test = (name, operation) => tests.push({ name, operation });

test('reads and backs up only the explicit owned key', () => {
  const raw = JSON.stringify(fixtureState());
  const { store, localStorage } = makeHarness({
    [stateKey]: raw,
    unrelated_secret: 'must-not-be-read',
  });
  const backup = store.rawBackup();
  assert.deepEqual(localStorage.reads.filter(key => key !== stateKey), []);
  assert.deepEqual(localStorage.writes, []);
  assert.equal(backup.records.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(backup.records[0])), {
    key: stateKey,
    present: true,
    raw_value: raw,
  });
});

test('accepts only plain or null-prototype records and enforces 128 KiB', () => {
  const { store } = makeHarness({ [stateKey]: JSON.stringify(fixtureState()) });
  assert.equal(store.isAppState(fixtureState()), true);
  const nullPrototypePreference = Object.create(null);
  nullPrototypePreference.camp_name = 'Camp';
  assert.equal(store.isPreferencesValue(nullPrototypePreference), true);
  assert.equal(store.isPreferencesValue({ camp_name: '' }), true);
  const accessorPreference = {};
  Object.defineProperty(accessorPreference, 'camp_name', {
    enumerable: true,
    get() {
      return 'Camp';
    },
  });
  assert.equal(store.isPreferencesValue(accessorPreference), false);
  const oversized = fixtureState().classes[0];
  oversized.events[0].hunts[0].coachLocation = 'x'.repeat(129 * 1024);
  assert.equal(store.isClassValue({
    class_id: oversized.id,
    class_data: oversized,
  }), false);
});

test('uses stable SHA-256 record IDs and excludes active selection', async () => {
  const state = fixtureState();
  const { store } = makeHarness({ [stateKey]: JSON.stringify(state) });
  const classes = await store.listClassRecords();
  const lessons = await store.listLessonRecords();
  const expectedClass = Buffer.from(await webcrypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('class-1')
  )).toString('hex');
  const expectedLesson = Buffer.from(await webcrypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('lesson-1')
  )).toString('hex');
  assert.equal(classes[0].recordId, `class:${expectedClass}`);
  assert.equal(lessons[0].recordId, `lesson:${expectedLesson}`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(store.preferencesValue(state))),
    { camp_name: state.campName }
  );
});

test('preserves malformed bytes and fails closed', async () => {
  const malformed = '{"schemaVersion":5,"unknown":true}';
  const { store, localStorage } = makeHarness({ [stateKey]: malformed });
  assert.equal(store.inspect().status, 'invalid');
  await assert.rejects(store.writeLocal(fixtureState()), /preserved|unknown|malformed/i);
  assert.equal(localStorage.getItem(stateKey), malformed);
});

test('stops stale CAS writes and records local generations', async () => {
  const original = fixtureState();
  const { store, localStorage } = makeHarness({ [stateKey]: JSON.stringify(original) });
  const external = fixtureState();
  external.campName = 'Other tab';
  localStorage.setItem(stateKey, JSON.stringify(external));
  const stale = fixtureState();
  stale.campName = 'Stale local';
  await assert.rejects(store.writeLocal(stale), /concurrent local save/i);
  assert.equal(JSON.parse(localStorage.getItem(stateKey)).campName, 'Other tab');

  const freshHarness = makeHarness({ [stateKey]: JSON.stringify(original) });
  const fresh = fixtureState();
  fresh.campName = 'Newest local';
  await freshHarness.store.writeLocal(fresh);
  assert.equal(freshHarness.store.getRevision().local, 1);
  assert.equal(JSON.parse(freshHarness.localStorage.getItem(stateKey)).campName, 'Newest local');
});

test('merges an observed cross-tab change without replacing unrelated records', async () => {
  const original = fixtureState();
  const originalRaw = JSON.stringify(original);
  const { store, localStorage, root } = makeHarness({ [stateKey]: originalRaw });
  const remote = fixtureState();
  remote.campName = 'Remote camp';
  remote.lessonTemplates[0].title = 'Remote lesson';
  const remoteRaw = JSON.stringify(remote);
  localStorage.setItem(stateKey, remoteRaw);
  root.dispatchEvent({
    type: 'storage',
    key: stateKey,
    oldValue: originalRaw,
    newValue: remoteRaw,
  });

  const local = fixtureState();
  local.classes[0].name = 'Newest local class';
  const merged = await store.writeLocal(local);
  assert.equal(merged.campName, 'Remote camp');
  assert.equal(merged.lessonTemplates[0].title, 'Remote lesson');
  assert.equal(merged.classes[0].name, 'Newest local class');
  assert.equal(store.getRevision().storage, 1);
  assert.equal(store.getRevision().local, 1);
});

test('rejects fixed tombstones, hash mismatches, and last-class deletion', async () => {
  const state = fixtureState();
  const { store, localStorage } = makeHarness({ [stateKey]: JSON.stringify(state) });
  await assert.rejects(
    store.applyPreferences(null, { source: 'remote', deleted: true }),
    /cannot delete/i
  );
  const classRecord = (await store.listClassRecords())[0];
  await assert.rejects(
    store.applyClassRecord(`class:${'0'.repeat(64)}`, classRecord.value, {
      source: 'remote',
      deleted: false,
    }),
    /rejected/i
  );
  await assert.rejects(
    store.applyClassRecord(classRecord.recordId, null, {
      source: 'remote',
      deleted: true,
    }),
    /only Scavenger Hunt class/i
  );
  assert.equal(localStorage.getItem(stateKey), JSON.stringify(state));
});

test('defers remote apply until the editor is idle and keeps newer local data', async () => {
  const safetyRoot = {};
  safetyRoot.window = safetyRoot;
  vm.runInContext(
    safetySource,
    vm.createContext({ window: safetyRoot, Promise, Error }),
    { filename: 'scavenger-sync-safety.js' }
  );

  let revision = { local: 0, storage: 0 };
  let releaseEditor;
  let operationCalled = false;
  const coordinator = safetyRoot.ScavengerSyncSafety.createRemoteApplyQueue({
    getRevision: () => ({ ...revision }),
    whenLocalIdle: async () => {},
    whenStagingSettled: async () => {},
    waitForEditorIdle: () => new Promise(resolve => {
      releaseEditor = resolve;
    }),
  });
  let settled = false;
  const deferred = coordinator({ source: 'remote' }, async fence => {
    operationCalled = true;
    assert.deepEqual(
      JSON.parse(JSON.stringify(fence)),
      { expectedLocalRevision: 0, expectedStorageRevision: 0 }
    );
  }).then(() => {
    settled = true;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false);
  assert.equal(operationCalled, false);
  releaseEditor();
  await deferred;
  assert.equal(operationCalled, true);

  operationCalled = false;
  let mutableRevision = { local: 0, storage: 0 };
  const guardedCoordinator = safetyRoot.ScavengerSyncSafety.createRemoteApplyQueue({
    getRevision: () => ({ ...mutableRevision }),
    whenLocalIdle: async () => {
      mutableRevision = { local: 1, storage: 0 };
    },
    whenStagingSettled: async () => {},
    waitForEditorIdle: async () => {},
  });
  await assert.rejects(
    guardedCoordinator({ source: 'remote' }, async () => {
      operationCalled = true;
    }),
    /newer local/i
  );
  assert.equal(operationCalled, false);
});

test('requires zero writes and blocks remote or orphaned migration records', () => {
  const safetyRoot = {};
  safetyRoot.window = safetyRoot;
  vm.runInContext(
    safetySource,
    vm.createContext({ window: safetyRoot, Promise, Error }),
    { filename: 'scavenger-sync-safety.js' }
  );
  const allowed = safetyRoot.ScavengerSyncSafety.migrationAllowed;
  const base = { writesPerformed: 0, remoteCount: 0, orphanedCount: 0 };
  assert.equal(allowed(base), true);
  assert.equal(allowed({ ...base, writesPerformed: 1 }), false);
  assert.equal(allowed({ ...base, remoteCount: 1 }), false);
  assert.equal(allowed({ ...base, orphanedCount: 1 }), false);
  assert.equal(allowed(null), false);
});

let passed = 0;
for (const { name, operation } of tests) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`1..${passed}`);
