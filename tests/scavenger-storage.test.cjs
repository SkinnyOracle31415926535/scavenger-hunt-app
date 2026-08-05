const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');

const source = readFileSync(
  new URL('../scavenger-storage.js', `file://${__filename}`),
  'utf8',
);

class FakeStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  snapshot() { return Object.fromEntries(this.values); }
}

class LockManager {
  constructor() { this.tail = Promise.resolve(); }
  request(_name, _options, task) {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }
}

function state(campName = 'Camp One') {
  const taskPool = [
    { id: 'task-one', text: 'Task one' },
    { id: 'task-two', text: 'Task two' },
    { id: 'task-three', text: 'Task three' },
  ];
  const plan = {
    eligibleTaskIds: taskPool.map((task) => task.id),
    selectedTaskIds: [],
    completedTaskIds: [],
    reshuffles: 0,
    hintRevealed: false,
    adminOverride: false,
  };
  const round = {
    id: 'round-one',
    title: 'Round One',
    clue: 'A safe clue',
    tasks: taskPool.map((task) => task.text),
    taskPool,
    taskSetsGenerated: false,
    studentTasks: { 'athlete-one': plan },
    eligibilityTemplates: [],
    athleteTaskTemplates: [],
    selectedTaskIds: [],
    completedTaskIds: [],
    reshuffles: 0,
  };
  return {
    schemaVersion: 5,
    mode: 'admin',
    campName,
    classes: [{
      id: 'class-one',
      name: 'Class One',
      athletes: [{ id: 'athlete-one', name: 'Avery' }],
      events: [{
        id: 'event-one',
        name: 'Floor',
        hunts: [{
          id: 'hunt-one',
          title: 'Hunt One',
          objectName: 'Star',
          coachLocation: 'Coach note',
          roundDuration: 10,
          pointValue: 1,
          status: 'draft',
          rounds: [round],
          revealedRoundIds: [],
          completions: {},
          assignments: {},
          winner: null,
        }],
      }],
    }],
    lessonTemplates: [],
  };
}

function load(initial = {}) {
  const localStorage = new FakeStorage(initial);
  const events = [];
  const window = {
    localStorage,
    navigator: { locks: new LockManager() },
    addEventListener() {},
    dispatchEvent(event) { events.push(event); return true; },
  };
  const context = vm.createContext({ window, TextEncoder, CustomEvent: class {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  } });
  new vm.Script(source, { filename: 'scavenger-storage.js' }).runInContext(context);
  const realm = (value) => {
    context.__json = JSON.stringify(value);
    return vm.runInContext('JSON.parse(__json)', context);
  };
  return { api: window.ScavengerStore, localStorage, events, realm };
}

test('temporary transfer validates first and replaces only Scavenger Hunt storage', async () => {
  const environment = load({
    'star-search-offline-v1': JSON.stringify(state()),
    unrelated: 'preserve me',
  });
  const snapshot = environment.api.transferSnapshot();
  assert.equal(environment.api.validateTransferSnapshot(snapshot), true);
  await environment.api.applyTransferSnapshot(environment.realm({ state: state('Transferred Camp') }));
  assert.equal(
    JSON.parse(environment.localStorage.getItem('star-search-offline-v1')).campName,
    'Transferred Camp',
  );
  assert.equal(environment.localStorage.getItem('unrelated'), 'preserve me');
  assert.equal(environment.events.at(-1).detail.source, 'migration');

  const before = environment.localStorage.snapshot();
  await assert.rejects(
    environment.api.applyTransferSnapshot(environment.realm({ state: {} })),
    /transfer file is invalid/,
  );
  assert.deepEqual(environment.localStorage.snapshot(), before);
});
