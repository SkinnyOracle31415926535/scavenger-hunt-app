(() => {
  'use strict';

  const APP_ID = 'scavenger-hunt';
  const STATE_KEY = 'star-search-offline-v1';
  const CHANGE_EVENT = 'scavenger-hunt-storage-change';
  const ERROR_EVENT = 'scavenger-hunt-storage-error';
  const LOCK_NAME = 'scavenger-hunt:aggregate-state-v1';
  const MAX_REMOTE_BYTES = 128 * 1024;
  const MAX_LOCAL_BYTES = 8 * 1024 * 1024;
  const MAX_CLASSES = 200;
  const MAX_ATHLETES = 500;
  const MAX_EVENTS = 24;
  const MAX_HUNTS = 500;
  const MAX_ROUNDS = 50;
  const MAX_TASKS = 500;
  const MAX_LESSONS = 1000;
  const root = window;
  const objectConstructorSource = Function.prototype.toString.call(Object);
  const localWriteTails = new Map();
  const revisions = {
    mutation: 0,
    local: 0,
    external: 0,
    storage: 0,
  };
  let knownRaw;
  let pendingStorageRaw;
  let lastError = null;

  try {
    knownRaw = root.localStorage.getItem(STATE_KEY);
  } catch (error) {
    knownRaw = undefined;
    lastError = error instanceof Error ? error : new Error('Browser storage is unavailable.');
  }

  const clone = value => JSON.parse(JSON.stringify(value));
  const rawByteLength = raw => new TextEncoder().encode(raw).byteLength;
  const byteLength = value => rawByteLength(JSON.stringify(value));

  const plainObject = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    const constructor = Object.prototype.hasOwnProperty.call(prototype, 'constructor')
      ? prototype.constructor
      : null;
    return typeof constructor === 'function'
      && Function.prototype.toString.call(constructor) === objectConstructorSource;
  };

  const exactKeys = (value, keys) => {
    if (!plainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = keys.slice().sort();
    return actual.length === expected.length
      && actual.every((key, index) => key === expected[index]);
  };

  const plainJson = (value, seen = new Set(), depth = 0) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 80) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      const valid = value.length <= 10000
        && value.every(item => plainJson(item, seen, depth + 1));
      seen.delete(value);
      return valid;
    }
    if (!plainObject(value)) {
      seen.delete(value);
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const valid = Reflect.ownKeys(descriptors).every(key => {
      const descriptor = descriptors[key];
      return typeof key === 'string'
        && descriptor.enumerable
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && plainJson(descriptor.value, seen, depth + 1);
    });
    seen.delete(value);
    return valid;
  };

  const validString = (value, maximum, allowEmpty = true) => (
    typeof value === 'string'
    && value.length <= maximum
    && (allowEmpty || value.trim().length > 0)
  );

  const validId = value => (
    validString(value, 200, false)
    && !/[\u0000-\u001f\u007f]/.test(value)
  );

  const validUniqueStringArray = (value, maximum, maximumLength = 200) => (
    Array.isArray(value)
    && value.length <= maximum
    && value.every(item => validString(item, maximumLength))
    && new Set(value).size === value.length
  );

  const uniqueIds = values => (
    new Set(values.map(value => value.id)).size === values.length
  );

  const validTask = value => (
    exactKeys(value, ['id', 'text'])
    && validId(value.id)
    && validString(value.text, 5000)
  );

  const validAthletePlan = (value, taskIds) => (
    exactKeys(value, [
      'eligibleTaskIds',
      'selectedTaskIds',
      'completedTaskIds',
      'reshuffles',
      'hintRevealed',
      'adminOverride',
    ])
    && validUniqueStringArray(value.eligibleTaskIds, MAX_TASKS)
    && validUniqueStringArray(value.selectedTaskIds, 3)
    && validUniqueStringArray(value.completedTaskIds, 3)
    && value.eligibleTaskIds.every(id => taskIds.has(id))
    && value.selectedTaskIds.every(id => value.eligibleTaskIds.includes(id))
    && value.completedTaskIds.every(id => value.selectedTaskIds.includes(id))
    && Number.isSafeInteger(value.reshuffles)
    && value.reshuffles >= 0
    && value.reshuffles <= 1000
    && typeof value.hintRevealed === 'boolean'
    && typeof value.adminOverride === 'boolean'
  );

  const validEligibilityTemplate = value => (
    exactKeys(value, ['athleteName', 'eligibleTaskTexts'])
    && validString(value.athleteName, 500, false)
    && validUniqueStringArray(value.eligibleTaskTexts, MAX_TASKS, 5000)
  );

  const validRound = (value, athleteIds, lesson = false) => {
    if (!exactKeys(value, [
      'id',
      'title',
      'clue',
      'tasks',
      'taskPool',
      'taskSetsGenerated',
      'studentTasks',
      'eligibilityTemplates',
      'athleteTaskTemplates',
      'selectedTaskIds',
      'completedTaskIds',
      'reshuffles',
    ])
      || !validId(value.id)
      || !validString(value.title, 2000)
      || !validString(value.clue, 50000)
      || !Array.isArray(value.taskPool)
      || value.taskPool.length > MAX_TASKS
      || !value.taskPool.every(validTask)
      || !uniqueIds(value.taskPool)
      || !Array.isArray(value.tasks)
      || value.tasks.length !== value.taskPool.length
      || value.tasks.some((text, index) => text !== value.taskPool[index].text)
      || typeof value.taskSetsGenerated !== 'boolean'
      || !plainObject(value.studentTasks)
      || !Array.isArray(value.eligibilityTemplates)
      || value.eligibilityTemplates.length > MAX_ATHLETES
      || !value.eligibilityTemplates.every(validEligibilityTemplate)
      || !Array.isArray(value.athleteTaskTemplates)
      || value.athleteTaskTemplates.length !== 0
      || !validUniqueStringArray(value.selectedTaskIds, 3)
      || !validUniqueStringArray(value.completedTaskIds, 3)
      || !Number.isSafeInteger(value.reshuffles)
      || value.reshuffles < 0
      || value.reshuffles > 1000) {
      return false;
    }
    const taskIds = new Set(value.taskPool.map(task => task.id));
    const studentIds = Object.keys(value.studentTasks);
    if (lesson) {
      return studentIds.length === 0;
    }
    return studentIds.length === athleteIds.size
      && studentIds.every(id => athleteIds.has(id))
      && studentIds.every(id => validAthletePlan(value.studentTasks[id], taskIds));
  };

  const validWinner = (value, athleteIds) => (
    value === null
    || (
      exactKeys(value, ['athleteId', 'points', 'foundAt'])
      && athleteIds.has(value.athleteId)
      && Number.isFinite(value.points)
      && value.points >= 0
      && value.points <= 99
      && validString(value.foundAt, 64, false)
      && Number.isFinite(Date.parse(value.foundAt))
    )
  );

  const validCompletions = (value, roundIds, athleteIds) => (
    plainObject(value)
    && Object.keys(value).length <= MAX_ROUNDS
    && Object.entries(value).every(([roundId, ids]) => (
      roundIds.has(roundId)
      && validUniqueStringArray(ids, MAX_ATHLETES)
      && ids.every(id => athleteIds.has(id))
    ))
  );

  const validAssignments = (value, roundIds, athleteIds) => (
    plainObject(value)
    && Object.keys(value).length <= MAX_ROUNDS
    && Object.entries(value).every(([roundId, assignments]) => (
      roundIds.has(roundId)
      && plainObject(assignments)
      && Object.keys(assignments).length <= MAX_ATHLETES
      && Object.entries(assignments).every(([athleteId, assignment]) => (
        athleteIds.has(athleteId)
        && Number.isSafeInteger(assignment)
        && assignment >= 0
        && assignment <= 10000
      ))
    ))
  );

  const validHunt = (value, athleteIds) => {
    if (!exactKeys(value, [
      'id',
      'title',
      'objectName',
      'coachLocation',
      'roundDuration',
      'pointValue',
      'status',
      'rounds',
      'revealedRoundIds',
      'completions',
      'assignments',
      'winner',
    ])
      || !validId(value.id)
      || !validString(value.title, 2000)
      || !validString(value.objectName, 5000)
      || !validString(value.coachLocation, 50000)
      || !Number.isFinite(value.roundDuration)
      || value.roundDuration < 1
      || value.roundDuration > 60
      || !Number.isFinite(value.pointValue)
      || value.pointValue < 0
      || value.pointValue > 99
      || !['draft', 'active', 'archived', 'found'].includes(value.status)
      || !Array.isArray(value.rounds)
      || value.rounds.length < 1
      || value.rounds.length > MAX_ROUNDS
      || !uniqueIds(value.rounds)
      || !value.rounds.every(round => validRound(round, athleteIds))
      || !validUniqueStringArray(value.revealedRoundIds, MAX_ROUNDS)
      || !validWinner(value.winner, athleteIds)) {
      return false;
    }
    const roundIds = new Set(value.rounds.map(round => round.id));
    return value.revealedRoundIds.every(id => roundIds.has(id))
      && validCompletions(value.completions, roundIds, athleteIds)
      && validAssignments(value.assignments, roundIds, athleteIds);
  };

  const validEvent = (value, athleteIds) => (
    exactKeys(value, ['id', 'name', 'hunts'])
    && validId(value.id)
    && validString(value.name, 500, false)
    && Array.isArray(value.hunts)
    && value.hunts.length >= 1
    && value.hunts.length <= MAX_HUNTS
    && uniqueIds(value.hunts)
    && value.hunts.every(hunt => validHunt(hunt, athleteIds))
  );

  const validClass = value => {
    if (!exactKeys(value, ['id', 'name', 'athletes', 'events'])
      || !validId(value.id)
      || !validString(value.name, 1000, false)
      || !Array.isArray(value.athletes)
      || value.athletes.length < 1
      || value.athletes.length > MAX_ATHLETES
      || !value.athletes.every(athlete => (
        exactKeys(athlete, ['id', 'name'])
        && validId(athlete.id)
        && validString(athlete.name, 500, false)
      ))
      || !uniqueIds(value.athletes)
      || !Array.isArray(value.events)
      || value.events.length < 1
      || value.events.length > MAX_EVENTS
      || !uniqueIds(value.events)) {
      return false;
    }
    const athleteIds = new Set(value.athletes.map(athlete => athlete.id));
    return value.events.every(event => validEvent(event, athleteIds));
  };

  const validLesson = value => (
    exactKeys(value, ['id', 'title', 'eventName', 'rounds'])
    && validId(value.id)
    && validString(value.title, 2000, false)
    && validString(value.eventName, 500, false)
    && Array.isArray(value.rounds)
    && value.rounds.length >= 1
    && value.rounds.length <= MAX_ROUNDS
    && uniqueIds(value.rounds)
    && value.rounds.every(round => validRound(round, new Set(), true))
  );

  const isAppState = value => (
    plainJson(value)
    && exactKeys(value, ['schemaVersion', 'mode', 'campName', 'classes', 'lessonTemplates'])
    && value.schemaVersion === 5
    && ['admin', 'play'].includes(value.mode)
    && validString(value.campName, 2000)
    && Array.isArray(value.classes)
    && value.classes.length >= 1
    && value.classes.length <= MAX_CLASSES
    && uniqueIds(value.classes)
    && value.classes.every(validClass)
    && Array.isArray(value.lessonTemplates)
    && value.lessonTemplates.length <= MAX_LESSONS
    && uniqueIds(value.lessonTemplates)
    && value.lessonTemplates.every(validLesson)
    && byteLength(value) <= MAX_LOCAL_BYTES
  );

  const isRecognizedHistoricalState = value => (
    plainJson(value)
    && plainObject(value)
    && [1, 2, 3, 4].includes(value.schemaVersion)
    && typeof value.campName === 'string'
    && Array.isArray(value.classes)
    && value.classes.length >= 1
    && value.classes.length <= MAX_CLASSES
    && value.classes.every(classRoom => (
      plainObject(classRoom)
      && Array.isArray(classRoom.athletes)
      && classRoom.athletes.length >= 1
      && classRoom.athletes.length <= MAX_ATHLETES
      && Array.isArray(classRoom.events)
      && classRoom.events.length >= 1
      && classRoom.events.length <= MAX_EVENTS
      && classRoom.events.every(event => (
        plainObject(event)
        && Array.isArray(event.hunts)
        && event.hunts.length >= 1
        && event.hunts.length <= MAX_HUNTS
      ))
    ))
    && Array.isArray(value.lessonTemplates)
    && value.lessonTemplates.length <= MAX_LESSONS
    && byteLength(value) <= MAX_LOCAL_BYTES
  );

  const preferencesValue = state => ({ camp_name: state.campName });
  const classValue = classRoom => ({ class_id: classRoom.id, class_data: clone(classRoom) });
  const lessonValue = lesson => ({ lesson_id: lesson.id, lesson_data: clone(lesson) });

  const isPreferencesValue = value => (
    plainJson(value)
    && exactKeys(value, ['camp_name'])
    && validString(value.camp_name, 2000)
    && byteLength(value) <= MAX_REMOTE_BYTES
  );

  const isClassValue = value => (
    plainJson(value)
    && exactKeys(value, ['class_id', 'class_data'])
    && validId(value.class_id)
    && validClass(value.class_data)
    && value.class_id === value.class_data.id
    && byteLength(value) <= MAX_REMOTE_BYTES
  );

  const isLessonValue = value => (
    plainJson(value)
    && exactKeys(value, ['lesson_id', 'lesson_data'])
    && validId(value.lesson_id)
    && validLesson(value.lesson_data)
    && value.lesson_id === value.lesson_data.id
    && byteLength(value) <= MAX_REMOTE_BYTES
  );

  const inspectionError = message => new Error(
    `${message} The exact ${STATE_KEY} value was preserved; download its raw backup before recovery.`
  );

  const inspectRaw = raw => {
    if (raw === null) {
      return { status: 'missing', raw, value: null, format: null, error: null };
    }
    if (typeof raw !== 'string' || rawByteLength(raw) > MAX_LOCAL_BYTES) {
      return {
        status: 'invalid',
        raw,
        value: null,
        format: null,
        error: inspectionError('Scavenger Hunt data is too large or unavailable.'),
      };
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return {
        status: 'invalid',
        raw,
        value: null,
        format: null,
        error: inspectionError('Scavenger Hunt data is not valid JSON.'),
      };
    }
    if (isAppState(value)) {
      return { status: 'valid', raw, value, format: 'schema-5', error: null };
    }
    if (isRecognizedHistoricalState(value)) {
      return {
        status: 'recoverable',
        raw,
        value,
        format: `schema-${value.schemaVersion}`,
        error: null,
      };
    }
    return {
      status: 'invalid',
      raw,
      value: null,
      format: null,
      error: inspectionError('Scavenger Hunt data has an unknown or malformed shape.'),
    };
  };

  const inspect = () => {
    try {
      const result = inspectRaw(root.localStorage.getItem(STATE_KEY));
      lastError = result.status === 'invalid' ? result.error : null;
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Browser storage is unavailable.');
      return {
        status: 'invalid',
        raw: null,
        value: null,
        format: null,
        error: lastError,
      };
    }
  };

  const readCandidate = () => {
    const result = inspect();
    return ['valid', 'recoverable'].includes(result.status) ? clone(result.value) : null;
  };

  const readState = () => {
    const result = inspect();
    if (result.status === 'missing') return null;
    if (result.status !== 'valid') throw result.error || inspectionError(
      'Scavenger Hunt data must be recovered before synchronization.'
    );
    return clone(result.value);
  };

  const publishError = error => {
    lastError = error instanceof Error ? error : new Error('Browser storage is unavailable.');
    root.dispatchEvent(new CustomEvent(ERROR_EVENT, {
      detail: { message: lastError.message },
    }));
  };

  const dispatchChange = detail => {
    root.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail }));
  };

  const withAggregateLock = callback => {
    if (!root.navigator?.locks?.request) {
      throw new Error(
        'This browser cannot safely coordinate Scavenger Hunt aggregate synchronization.'
      );
    }
    return root.navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, callback);
  };

  const currentRevision = () => ({ ...revisions });

  const checkFence = (fence = {}) => {
    if (Number.isInteger(fence.expectedMutationRevision)
      && revisions.mutation !== fence.expectedMutationRevision) {
      throw new Error(
        'Scavenger Hunt stopped a stale aggregate mutation before it could replace newer data.'
      );
    }
    if (Number.isInteger(fence.expectedLocalRevision)
      && revisions.local !== fence.expectedLocalRevision) {
      throw new Error(
        'A newer local Scavenger Hunt edit was preserved instead of synchronized data.'
      );
    }
    if (Number.isInteger(fence.expectedStorageRevision)
      && revisions.storage !== fence.expectedStorageRevision) {
      throw new Error(
        'A newer browser-tab Scavenger Hunt edit was preserved instead of synchronized data.'
      );
    }
    if (Number.isInteger(fence.expectedExternalRevision)
      && revisions.external !== fence.expectedExternalRevision) {
      throw new Error(
        'Scavenger Hunt stopped a local save because synchronized data changed first.'
      );
    }
  };

  const recordMutation = source => {
    revisions.mutation += 1;
    if (source === 'local' || source === 'recovery') revisions.local += 1;
    if (source === 'remote' || source === 'migration' || source === 'storage') {
      revisions.external += 1;
    }
    if (source === 'storage') revisions.storage += 1;
  };

  const commitUnlocked = (candidate, {
    source,
    expectedRaw,
    allowRecovery = false,
    ...fence
  }) => {
    checkFence(fence);
    const next = clone(candidate);
    if (!isAppState(next)) {
      throw new Error('Scavenger Hunt rejected an invalid aggregate save.');
    }
    const currentRaw = root.localStorage.getItem(STATE_KEY);
    if (expectedRaw !== undefined && currentRaw !== expectedRaw) {
      throw new Error(
        'Scavenger Hunt stopped a concurrent aggregate mutation before it could replace newer data.'
      );
    }
    const inspected = inspectRaw(currentRaw);
    if (inspected.status === 'invalid') throw inspected.error;
    if (inspected.status === 'recoverable' && !allowRecovery) {
      throw inspectionError(
        `Recognized historical ${inspected.format} data requires a raw backup before normalization.`
      );
    }
    const nextRaw = JSON.stringify(next);
    if (currentRaw === nextRaw) {
      knownRaw = currentRaw;
      if (pendingStorageRaw === currentRaw) pendingStorageRaw = undefined;
      return next;
    }
    root.localStorage.setItem(STATE_KEY, nextRaw);
    if (root.localStorage.getItem(STATE_KEY) !== nextRaw) {
      throw new Error('Scavenger Hunt could not verify its local save.');
    }
    knownRaw = nextRaw;
    pendingStorageRaw = undefined;
    recordMutation(source);
    lastError = null;
    dispatchChange({
      key: STATE_KEY,
      source,
      oldRaw: currentRaw,
      newRaw: nextRaw,
      revision: currentRevision(),
    });
    return next;
  };

  const enqueueLocalWrite = operation => {
    const previous = localWriteTails.get(STATE_KEY) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    localWriteTails.set(STATE_KEY, task);
    void task.finally(() => {
      if (localWriteTails.get(STATE_KEY) === task) localWriteTails.delete(STATE_KEY);
    }).catch(() => {});
    return task;
  };

  const whenLocalIdle = async () => {
    while (localWriteTails.has(STATE_KEY)) {
      const current = localWriteTails.get(STATE_KEY);
      await current.catch(() => {});
      if (localWriteTails.get(STATE_KEY) === current) return;
    }
  };

  const mergeChangedRecords = (baseItems, localItems, currentItems) => {
    const base = new Map(baseItems.map(item => [item.id, item]));
    const local = new Map(localItems.map(item => [item.id, item]));
    const merged = new Map(currentItems.map(item => [item.id, clone(item)]));
    const identities = new Set([...base.keys(), ...local.keys()]);
    for (const identity of identities) {
      const before = base.get(identity);
      const after = local.get(identity);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (after === undefined) merged.delete(identity);
      else merged.set(identity, clone(after));
    }
    return [...merged.values()];
  };

  const mergeObservedStorageChange = (baseRaw, currentRaw, localCandidate) => {
    const base = inspectRaw(baseRaw);
    const current = inspectRaw(currentRaw);
    if (base.status !== 'valid' || current.status !== 'valid') {
      throw new Error(
        'Scavenger Hunt stopped a cross-tab merge because its safe base was unavailable.'
      );
    }
    const merged = clone(current.value);
    merged.mode = localCandidate.mode;
    if (base.value.campName !== localCandidate.campName) {
      merged.campName = localCandidate.campName;
    }
    merged.classes = mergeChangedRecords(
      base.value.classes,
      localCandidate.classes,
      current.value.classes
    );
    merged.lessonTemplates = mergeChangedRecords(
      base.value.lessonTemplates,
      localCandidate.lessonTemplates,
      current.value.lessonTemplates
    );
    if (!isAppState(merged)) {
      throw new Error(
        'Concurrent Scavenger Hunt edits need review; neither version was overwritten.'
      );
    }
    return merged;
  };

  const writeLocal = candidate => {
    const next = clone(candidate);
    if (!isAppState(next)) {
      return Promise.reject(new Error('Scavenger Hunt rejected an invalid local save.'));
    }
    const expectedExternalRevision = revisions.external;
    return enqueueLocalWrite(() => withAggregateLock(() => {
      checkFence({ expectedExternalRevision });
      const currentRaw = root.localStorage.getItem(STATE_KEY);
      const inspected = inspectRaw(currentRaw);
      if (inspected.status === 'invalid') throw inspected.error;
      if (inspected.status === 'recoverable') {
        throw inspectionError(
          `Recognized historical ${inspected.format} data requires a raw backup before editing.`
        );
      }
      if (knownRaw !== currentRaw) {
        if (pendingStorageRaw !== currentRaw) {
          throw new Error(
            'Scavenger Hunt stopped a concurrent local save before it could replace newer data.'
          );
        }
        return commitUnlocked(
          mergeObservedStorageChange(knownRaw, currentRaw, next),
          {
            source: 'local',
            expectedRaw: currentRaw,
            expectedExternalRevision,
          }
        );
      }
      return commitUnlocked(next, {
        source: 'local',
        expectedRaw: currentRaw,
        expectedExternalRevision,
      });
    })).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const acknowledgeCurrentStorage = () => withAggregateLock(() => {
    const currentRaw = root.localStorage.getItem(STATE_KEY);
    const inspected = inspectRaw(currentRaw);
    if (!['missing', 'valid'].includes(inspected.status)) {
      throw inspected.error || new Error(
        'Scavenger Hunt could not acknowledge malformed browser storage.'
      );
    }
    knownRaw = currentRaw;
    if (pendingStorageRaw === currentRaw) pendingStorageRaw = undefined;
    return inspected.status === 'valid' ? clone(inspected.value) : null;
  });

  const normalizeRecoverable = (candidate, { backupConfirmed = false } = {}) => {
    if (!backupConfirmed) {
      return Promise.reject(new Error(
        'Download the exact raw backup before normalizing historical Scavenger Hunt data.'
      ));
    }
    const next = clone(candidate);
    if (!isAppState(next)) {
      return Promise.reject(new Error(
        'Historical Scavenger Hunt data did not normalize to the current safe format.'
      ));
    }
    return withAggregateLock(() => {
      const currentRaw = root.localStorage.getItem(STATE_KEY);
      const inspected = inspectRaw(currentRaw);
      if (inspected.status !== 'recoverable') {
        throw new Error('No recognized historical Scavenger Hunt data needs normalization.');
      }
      if (knownRaw !== currentRaw) {
        throw new Error(
          'Historical Scavenger Hunt data changed during recovery. Nothing was normalized.'
        );
      }
      return commitUnlocked(next, {
        source: 'recovery',
        expectedRaw: currentRaw,
        allowRecovery: true,
      });
    }).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const rawBackup = () => {
    const raw = root.localStorage.getItem(STATE_KEY);
    return {
      version: 1,
      kind: 'scavenger_hunt_browser_local_raw_backup',
      app_id: APP_ID,
      exported_at: new Date().toISOString(),
      records: [{
        key: STATE_KEY,
        present: raw !== null,
        raw_value: raw,
      }],
    };
  };

  // Temporary local transfer support. It intentionally bypasses remote sync
  // registration: importing a file is a reviewed browser-local replacement.
  const transferSnapshot = () => {
    const inspected = inspect();
    if (inspected.status === 'missing') return { state: null };
    if (inspected.status !== 'valid') {
      throw inspected.error || inspectionError(
        'Scavenger Hunt data must be backed up and reviewed before transfer.'
      );
    }
    return { state: clone(inspected.value) };
  };

  const validateTransferSnapshot = candidate => (
    exactKeys(candidate, ['state'])
    && (candidate.state === null || isAppState(candidate.state))
  );

  const applyTransferSnapshot = candidate => {
    if (!validateTransferSnapshot(candidate)) {
      return Promise.reject(new Error('The Scavenger Hunt transfer file is invalid.'));
    }
    return whenLocalIdle().then(() => withAggregateLock(() => {
      const currentRaw = root.localStorage.getItem(STATE_KEY);
      const nextRaw = candidate.state === null ? null : JSON.stringify(clone(candidate.state));
      if (currentRaw === nextRaw) return true;
      if (nextRaw === null) root.localStorage.removeItem(STATE_KEY);
      else root.localStorage.setItem(STATE_KEY, nextRaw);
      if (root.localStorage.getItem(STATE_KEY) !== nextRaw) {
        throw new Error('Scavenger Hunt could not verify its temporary data import.');
      }
      knownRaw = nextRaw;
      pendingStorageRaw = undefined;
      recordMutation('migration');
      lastError = null;
      dispatchChange({
        key: STATE_KEY,
        source: 'migration',
        oldRaw: currentRaw,
        newRaw: nextRaw,
        revision: currentRevision(),
      });
      return true;
    })).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const hashedRecordId = async (prefix, identity) => {
    if (!validId(identity)) {
      throw new Error(`Scavenger Hunt could not identify a ${prefix} record.`);
    }
    const digest = await root.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(identity)
    );
    const hex = Array.from(
      new Uint8Array(digest),
      byte => byte.toString(16).padStart(2, '0')
    ).join('');
    return `${prefix}:${hex}`;
  };

  const classRecordId = classId => hashedRecordId('class', classId);
  const lessonRecordId = lessonId => hashedRecordId('lesson', lessonId);
  const verifyClassRecordId = async (recordId, classId) => (
    typeof recordId === 'string'
    && /^class:[a-f0-9]{64}$/.test(recordId)
    && recordId === await classRecordId(classId)
  );
  const verifyLessonRecordId = async (recordId, lessonId) => (
    typeof recordId === 'string'
    && /^lesson:[a-f0-9]{64}$/.test(recordId)
    && recordId === await lessonRecordId(lessonId)
  );

  const collisionCheckedRecords = async (items, prefix, idFor, valueFor, validator) => {
    const records = [];
    const identities = new Map();
    for (const item of items.slice().sort((left, right) => left.id.localeCompare(right.id))) {
      const recordId = await idFor(item.id);
      const previous = identities.get(recordId);
      if (previous && previous !== item.id) {
        throw new Error(`Scavenger Hunt detected a ${prefix} record-ID collision.`);
      }
      identities.set(recordId, item.id);
      const value = valueFor(item);
      if (!validator(value)) {
        throw new Error(
          `A Scavenger Hunt ${prefix} record is invalid or larger than 128 KiB. `
          + 'It remains local and synchronization is blocked.'
        );
      }
      records.push({ recordId, value });
    }
    return records;
  };

  const listClassRecords = () => withAggregateLock(async () => {
    const state = readState();
    if (!state) return [];
    return collisionCheckedRecords(
      state.classes,
      'class',
      classRecordId,
      classValue,
      isClassValue
    );
  });

  const listLessonRecords = () => withAggregateLock(async () => {
    const state = readState();
    if (!state) return [];
    return collisionCheckedRecords(
      state.lessonTemplates,
      'lesson',
      lessonRecordId,
      lessonValue,
      isLessonValue
    );
  });

  const recordMap = (items, valueFor) => new Map(
    items.map(item => [item.id, valueFor(item)])
  );

  const parseCurrentRaw = (raw, allowRecoverableAsMissing = false) => {
    const inspected = inspectRaw(raw);
    if (inspected.status === 'missing') return null;
    if (allowRecoverableAsMissing && inspected.status === 'recoverable') return null;
    if (inspected.status !== 'valid') throw inspected.error || new Error(
      'Scavenger Hunt data must be recovered before synchronization.'
    );
    return inspected.value;
  };

  const diffRecords = async (oldRaw, newRaw) => {
    const next = parseCurrentRaw(newRaw);
    if (!next) {
      throw new Error('Scavenger Hunt synchronization cannot stage a deleted workspace.');
    }
    const previous = parseCurrentRaw(oldRaw, true);
    const beforeClasses = recordMap(previous?.classes || [], classValue);
    const afterClasses = recordMap(next.classes, classValue);
    const beforeLessons = recordMap(previous?.lessonTemplates || [], lessonValue);
    const afterLessons = recordMap(next.lessonTemplates, lessonValue);

    const makeChanges = async (before, after, idFor, validator, label) => {
      const changes = [];
      const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
      const recordIdentities = new Map();
      for (const identity of ids) {
        const recordId = await idFor(identity);
        const collision = recordIdentities.get(recordId);
        if (collision && collision !== identity) {
          throw new Error(`Scavenger Hunt detected a ${label} record-ID collision.`);
        }
        recordIdentities.set(recordId, identity);
        const oldValue = before.get(identity);
        const newValue = after.get(identity);
        if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
        if (newValue !== undefined && !validator(newValue)) {
          throw new Error(
            `A changed Scavenger Hunt ${label} is invalid or larger than 128 KiB. `
            + 'It remains local and was not synchronized.'
          );
        }
        changes.push({
          recordId,
          deleted: newValue === undefined,
          value: newValue === undefined ? undefined : clone(newValue),
        });
      }
      return changes;
    };

    return {
      preferencesChanged:
        JSON.stringify(previous ? preferencesValue(previous) : undefined)
          !== JSON.stringify(preferencesValue(next)),
      preferences: preferencesValue(next),
      classes: await makeChanges(
        beforeClasses,
        afterClasses,
        classRecordId,
        isClassValue,
        'class'
      ),
      lessons: await makeChanges(
        beforeLessons,
        afterLessons,
        lessonRecordId,
        isLessonValue,
        'lesson'
      ),
    };
  };

  const findIdentityByRecordId = async (items, recordId, verify) => {
    let identity = null;
    for (const item of items) {
      if (!await verify(recordId, item.id)) continue;
      if (identity && identity !== item.id) {
        throw new Error('Scavenger Hunt detected a synchronized record-ID collision.');
      }
      identity = item.id;
    }
    return identity;
  };

  const remoteFence = options => ({
    expectedLocalRevision: options.expectedLocalRevision,
    expectedStorageRevision: options.expectedStorageRevision,
  });

  const applyPreferences = (value, {
    source = 'remote',
    deleted = false,
    ...options
  } = {}) => {
    if (deleted) {
      return Promise.reject(new Error(
        'Synchronization cannot delete Scavenger Hunt preferences.'
      ));
    }
    if (!isPreferencesValue(value)) {
      return Promise.reject(new Error('Synchronized Scavenger Hunt preferences were rejected.'));
    }
    return withAggregateLock(() => {
      checkFence(remoteFence(options));
      const startingRaw = root.localStorage.getItem(STATE_KEY);
      const state = parseCurrentRaw(startingRaw);
      if (!state) {
        throw new Error('Synchronized preferences cannot replace a missing local camp.');
      }
      state.campName = value.camp_name;
      return commitUnlocked(state, {
        source: source === 'migration' ? 'migration' : 'remote',
        expectedRaw: startingRaw,
        ...remoteFence(options),
      });
    }).catch(error => {
      publishError(error);
      throw error;
    });
  };

  const applyClassRecord = (recordId, value, {
    source = 'remote',
    deleted = false,
    ...options
  } = {}) => withAggregateLock(async () => {
    checkFence(remoteFence(options));
    if (typeof recordId !== 'string' || !/^class:[a-f0-9]{64}$/.test(recordId)) {
      throw new Error('A synchronized Scavenger Hunt class identifier was rejected.');
    }
    const startingRaw = root.localStorage.getItem(STATE_KEY);
    const state = parseCurrentRaw(startingRaw);
    if (!state) throw new Error('A synchronized class cannot replace a missing local camp.');
    const existingId = await findIdentityByRecordId(
      state.classes,
      recordId,
      verifyClassRecordId
    );
    checkFence(remoteFence(options));
    if (root.localStorage.getItem(STATE_KEY) !== startingRaw) {
      throw new Error('A newer Scavenger Hunt camp was preserved.');
    }
    if (deleted) {
      if (!existingId) return state;
      if (state.classes.length <= 1) {
        throw new Error('Synchronization cannot delete the only Scavenger Hunt class.');
      }
      state.classes = state.classes.filter(classRoom => classRoom.id !== existingId);
    } else {
      if (!isClassValue(value)
        || !await verifyClassRecordId(recordId, value.class_id)
        || (existingId && existingId !== value.class_id)) {
        throw new Error(
          'A synchronized Scavenger Hunt class was rejected. Local data was preserved.'
        );
      }
      const index = state.classes.findIndex(classRoom => classRoom.id === value.class_id);
      if (index === -1) state.classes.push(clone(value.class_data));
      else state.classes[index] = clone(value.class_data);
    }
    return commitUnlocked(state, {
      source: source === 'migration' ? 'migration' : 'remote',
      expectedRaw: startingRaw,
      ...remoteFence(options),
    });
  }).catch(error => {
    publishError(error);
    throw error;
  });

  const applyLessonRecord = (recordId, value, {
    source = 'remote',
    deleted = false,
    ...options
  } = {}) => withAggregateLock(async () => {
    checkFence(remoteFence(options));
    if (typeof recordId !== 'string' || !/^lesson:[a-f0-9]{64}$/.test(recordId)) {
      throw new Error('A synchronized Scavenger Hunt lesson identifier was rejected.');
    }
    const startingRaw = root.localStorage.getItem(STATE_KEY);
    const state = parseCurrentRaw(startingRaw);
    if (!state) throw new Error('A synchronized lesson cannot replace a missing local camp.');
    const existingId = await findIdentityByRecordId(
      state.lessonTemplates,
      recordId,
      verifyLessonRecordId
    );
    checkFence(remoteFence(options));
    if (root.localStorage.getItem(STATE_KEY) !== startingRaw) {
      throw new Error('A newer Scavenger Hunt lesson library was preserved.');
    }
    if (deleted) {
      if (!existingId) return state;
      state.lessonTemplates = state.lessonTemplates.filter(lesson => lesson.id !== existingId);
    } else {
      if (!isLessonValue(value)
        || !await verifyLessonRecordId(recordId, value.lesson_id)
        || (existingId && existingId !== value.lesson_id)) {
        throw new Error(
          'A synchronized Scavenger Hunt lesson was rejected. Local data was preserved.'
        );
      }
      const index = state.lessonTemplates.findIndex(lesson => lesson.id === value.lesson_id);
      if (index === -1) state.lessonTemplates.push(clone(value.lesson_data));
      else state.lessonTemplates[index] = clone(value.lesson_data);
    }
    return commitUnlocked(state, {
      source: source === 'migration' ? 'migration' : 'remote',
      expectedRaw: startingRaw,
      ...remoteFence(options),
    });
  }).catch(error => {
    publishError(error);
    throw error;
  });

  const verifyCurrentPreferences = (value, { deleted = false } = {}) => (
    withAggregateLock(() => {
      const state = readState();
      if (deleted || !state
        || JSON.stringify(preferencesValue(state)) !== JSON.stringify(value)) {
        throw new Error(
          'Stale Scavenger Hunt preferences were not allowed to replace newer local data.'
        );
      }
      return clone(value);
    })
  );

  const verifyCurrentClassRecord = (recordId, value, { deleted = false } = {}) => (
    withAggregateLock(async () => {
      const state = readState();
      if (!state) throw new Error('A staged class cannot use a missing local camp.');
      const existingId = await findIdentityByRecordId(
        state.classes,
        recordId,
        verifyClassRecordId
      );
      if (deleted) {
        if (existingId) {
          throw new Error('A stale class deletion was not allowed to remove newer local data.');
        }
        return;
      }
      if (!isClassValue(value)
        || !await verifyClassRecordId(recordId, value.class_id)
        || existingId !== value.class_id
        || JSON.stringify(classValue(state.classes.find(item => item.id === existingId)))
          !== JSON.stringify(value)) {
        throw new Error('A stale class save was not allowed to replace newer local data.');
      }
      return clone(value);
    })
  );

  const verifyCurrentLessonRecord = (recordId, value, { deleted = false } = {}) => (
    withAggregateLock(async () => {
      const state = readState();
      if (!state) throw new Error('A staged lesson cannot use a missing local camp.');
      const existingId = await findIdentityByRecordId(
        state.lessonTemplates,
        recordId,
        verifyLessonRecordId
      );
      if (deleted) {
        if (existingId) {
          throw new Error('A stale lesson deletion was not allowed to remove newer local data.');
        }
        return;
      }
      if (!isLessonValue(value)
        || !await verifyLessonRecordId(recordId, value.lesson_id)
        || existingId !== value.lesson_id
        || JSON.stringify(lessonValue(
          state.lessonTemplates.find(item => item.id === existingId)
        )) !== JSON.stringify(value)) {
        throw new Error('A stale lesson save was not allowed to replace newer local data.');
      }
      return clone(value);
    })
  );

  root.addEventListener('storage', event => {
    if (event.key !== STATE_KEY) return;
    try {
      const inspected = inspectRaw(event.newValue);
      if (inspected.status === 'invalid') throw inspected.error;
      pendingStorageRaw = event.newValue;
      recordMutation('storage');
      lastError = null;
      dispatchChange({
        key: STATE_KEY,
        source: 'storage',
        oldRaw: event.oldValue,
        newRaw: event.newValue,
        revision: currentRevision(),
      });
    } catch (error) {
      publishError(error);
    }
  });

  root.ScavengerStore = Object.freeze({
    appId: APP_ID,
    stateKey: STATE_KEY,
    changeEvent: CHANGE_EVENT,
    errorEvent: ERROR_EVENT,
    lockName: LOCK_NAME,
    maxRemoteBytes: MAX_REMOTE_BYTES,
    inspect,
    inspectRaw,
    readCandidate,
    readState,
    rawBackup,
    transferSnapshot,
    validateTransferSnapshot,
    applyTransferSnapshot,
    normalizeRecoverable,
    writeLocal,
    whenLocalIdle,
    acknowledgeCurrentStorage,
    preferencesValue,
    classValue,
    lessonValue,
    listClassRecords,
    listLessonRecords,
    diffRecords,
    classRecordId,
    lessonRecordId,
    verifyClassRecordId,
    verifyLessonRecordId,
    applyPreferences,
    applyClassRecord,
    applyLessonRecord,
    verifyCurrentPreferences,
    verifyCurrentClassRecord,
    verifyCurrentLessonRecord,
    isAppState,
    isPreferencesValue,
    isClassValue,
    isLessonValue,
    getRevision: currentRevision,
    getLastError: () => lastError,
  });
})();
