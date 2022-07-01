const uint64Regex = /^[0-9]+$/;
const int64Regex = /^-?[0-9]+$/;
const hex128Regex = /^0[xX][0-9A-Fa-f]{1,32}$/;

class State {
  constructor() {
    this.path = [];
    this.errors = [];
    this.warnings = [];
  }

  error(msg) {
    this.errors.push({path: [...this.path], msg});
  }

  warn(msg) {
    this.warnings.push({path: [...this.path], msg});
  }

  scope(scope, f) {
    this.path.push(scope);
    f();
    this.path.pop();
  }

  result() {
    return {errors: this.errors, warnings: this.warnings};
  }

  validate(obj, checks) {
    Object.entries(checks).forEach(([key, check]) =>
        this.scope(key, () => check(this, obj, key)));

    Object.keys(obj).forEach(key => {
      if (!(key in checks)) {
        this.scope(key, () => this.warn('unknown field'));
      }
    });
  }
};

function required(f = () => {}) {
  return (state, object, key) => {
    if (key in object) {
      f(state, object[key]);
      return;
    }
    state.error('missing required field');
  };
}

function optional(f = () => {}) {
  return (state, object, key) => {
    if (key in object) {
      f(state, object[key]);
    }
  };
}

function string(f = () => {}) {
  return (state, value) => {
    if (typeof value === 'string') {
      f(state, value);
      return;
    }
    state.error('must be a string');
  };
}

function object(f = () => {}) {
  return (state, value) => {
    if (typeof value === 'object' && value.constructor === Object) {
      Object.entries(value).forEach(([key, value]) =>
          state.scope(key, () => f(state, key, value)));
      return true;
    }
    state.error('must be an object');
    return false;
  }
}

function list(f = () => {}) {
  return (state, values) => {
    if (values instanceof Array) {
      values.forEach((value, index) =>
          state.scope(index, () => f(state, value)));
      return;
    }
    state.error('must be a list');
  }
}

const uint64 = string((state, value) => {
  if (!uint64Regex.test(value)) {
    state.error(`must be a uint64 (must match ${uint64Regex})`);
    return;
  }

  const max = 2n ** 64n - 1n;
  if (BigInt(value) > max) {
    state.error('must fit in an unsigned 64-bit integer');
  }
});

const int64 = string((state, value) => {
  if (!int64Regex.test(value)) {
  state.error(`must be a uint64 (must match ${uint64Regex})`);
    return;
  }

  value = BigInt(value);

  const max = 2n ** (64n - 1n) - 1n;
  const min = (-2n) ** (64n - 1n);
  if (value < min || value > max) {
    state.error('must fit in a signed 64-bit integer');
  }
});

const hex128 = string((state, value) => {
  if (!hex128Regex.test(value)) {
    return state.error(`must be a hex128 (must match ${hex128Regex})`);
  }
});

const destination = string((state, url) => {
  try {
    url = new URL(url);
  } catch {
    state.error('must contain a valid URL');
    return;
  }

  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' &&
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    state.error('must contain a potentially trustworthy URL');
  }

  if (url.pathname !== '/') {
    state.warn('contains a path that will be ignored');
  }

  if (url.search !== '') {
    state.warn('contains a query string that will be ignored');
  }

  if (url.hash !== '') {
    state.warn('contains a fragment that will be ignored');
  }
});

// TODO: Check length of lists and strings.
const filters = (allowSourceType = true) => object((state, filter, values) => {
  if (filter === 'source_type' && !allowSourceType) {
    state.error('is prohibited because it is implicitly set');
    return;
  }

  list(string())(state, values);
});

// TODO: check length of key
const aggregationKeys = object((state, key, value) => {
  hex128(state, value);
});

export function validateSource(source) {
  const state = new State();
  state.validate(source, {
    aggregation_keys : optional(aggregationKeys),
    debug_key : optional(uint64),
    destination : required(destination),
    filter_data : optional(filters(/*allowSourceType=*/false)),
    priority : optional(int64),
    source_event_id : required(uint64),
  });
  return state.result();
}

const aggregatableTriggerData = list((state, value) => state.validate(value, {
  filters: optional(filters()),
  key_piece: required(hex128),
  not_filters: optional(filters()),
  source_keys: required(list(string())),
}));

// TODO: check length of key
const aggregatableValues = object((state, key, value) => {
  const max = 65536;
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    state.error(`must be an integer in the range (1, ${max}]`);
  }
});

const eventTriggerData = list((state, value) => state.validate(value, {
  deduplication_key: optional(uint64),
  filters : optional(filters()),
  not_filters : optional(filters()),
  priority: optional(int64),
  trigger_data: required(uint64),
}));

export function validateTrigger(trigger) {
  const state = new State();
  state.validate(trigger, {
    aggregatable_trigger_data : optional(aggregatableTriggerData),
    aggregatable_values : optional(aggregatableValues),
    debug_key : optional(uint64),
    event_trigger_data : optional(eventTriggerData),
    filters : optional(filters()),
    not_filters : optional(filters()),
  });
  return state.result();
}

export function validateJSON(json, f) {
  let value;
  try {
    value = JSON.parse(json);
  } catch (err) {
    return {errors: [{msg: err.message}], warnings: []};
  }
  return f(value);
}

export function formatIssue({msg, path}) {
  if (path === undefined) {
    return msg;
  }

  let context;
  if (path.length === 0) {
    context = 'JSON root';
  } else {
    context = path.map(p => typeof p === 'number' ? `[${p}]` : `["${p}"]`).join('');
  }

  return `${msg}: ${context}`;
}