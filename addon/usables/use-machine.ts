import { assert } from '@ember/debug';
import { action } from '@ember/object';
import { cancel, later } from '@ember/runloop';
import { DEBUG } from '@glimmer/env';
import { tracked } from '@glimmer/tracking';
import { Resource } from 'ember-could-get-used-to-this';
import type {
  EventObject,
  Interpreter,
  MachineConfig,
  MachineOptions,
  State,
  StateMachine,
  StateSchema,
  Typestate,
} from 'xstate';
import { interpret, Machine } from 'xstate';
import type { StateListener } from 'xstate/lib/interpreter';

const INTERPRETER = Symbol('interpreter');
const CONFIG = Symbol('config');
const MACHINE = Symbol('machine');

const ERROR_CANT_RECONFIGURE = `Cannot re-invoke withContext after the interpreter has been initialized`;
const ERROR_CHART_MISSING = `A statechart was not passed`;

type Args<Context, Schema extends StateSchema, Event extends EventObject> = {
  positional?: [
    any,
    MachineConfig<Context, Schema, Event>,
    Partial<MachineOptions<Context, Event>> &
      StateListener<Context, Event, Schema, Typestate<Context>>
  ];
};

const gatherActions = function (object, actionsArray) {
  for (let k in object) {
    if (['entry', 'exit', 'actions'].includes(k)) {
      if (Array.isArray(object[k])) {
        actionsArray = actionsArray.concat(object[k]);
      } else if (typeof object[k] === 'string') {
        actionsArray.push(object[k]);
      }
    } else if (typeof object[k] === 'object' && object[k] !== null) {
      actionsArray = gatherActions(object[k], actionsArray);
    }
  }
  return actionsArray;
};

const gatherGuards = function (object, acc) {
  for (let k in object) {
    if (k === 'cond') {
      if (typeof object[k] === 'object' && object[k] !== null && object[k].hasOwnProperty('type')) {
        acc.push(object[k].type);
      } else {
        acc.push(object[k]);
      }
      acc.push(object[k]);
    } else if (typeof object[k] === 'object' && object[k] !== null) {
      acc = gatherGuards(object[k], acc);
    }
  }
  return acc;
};

const gatherActivities = function (object, acc) {
  for (let k in object) {
    if (k === 'activities') {
      acc = acc.concat(object[k]);
    } else if (typeof object[k] === 'object' && object[k] !== null) {
      acc = gatherActivities(object[k], acc);
    }
  }
  return acc;
};

const gatherDelays = function (object, acc) {
  for (let k in object) {
    if (k === 'after') {
      if (typeof object[k] === 'object' && object[k] !== null) {
        acc = acc.concat(Object.keys(object[k]));
      } else if (Array.isArray(object[k])) {
        object[k].forEach((el) => {
          for (let key in el) {
            if (key === 'delay') {
              acc.push(el[key]);
            }
          }
        });
      }
    } else if (typeof object[k] === 'object' && object[k] !== null) {
      acc = gatherDelays(object[k], acc);
    }
  }
  return acc;
};

type SendArgs<Context, Schema extends StateSchema, Event extends EventObject> = Parameters<
  Interpreter<Context, Schema, Event>['send']
>;

/**
 *
  @use statechart = new Statechart(() => [{
    owner: this,
    chart,
    // below are optional:
    context,
    activities,
    guards,
    delays,
    onTransition,
    update
  }])
 */
export class Statechart<
  Context,
  Schema extends StateSchema,
  Event extends EventObject
> extends Resource<Args<Context, Schema, Event>> {
  declare [MACHINE]: StateMachine<Context, Schema, Event>;
  declare [INTERPRETER]: Interpreter<Context, Schema, Event>;

  @tracked state?: State<Context, Event>;

  /**
   * This is the return value of `new Statechart(() => ...)`
   */
  get value(): {
    state?: State<Context, Event>;
    send: Statechart<Context, Schema, Event>['send'];
  } {
    return {
      // For TypeScript, this is tricky because this is what is accessible at the call site
      // but typescript thinks the context is the class instance.
      //
      // To remedy, each property has to also exist on the class body under the same name
      state: this.state,
      send: this.send,
    };
  }

  /**
   * Private
   */

  @action
  send(...args: SendArgs<Context, Schema, Event>) {
    return this[INTERPRETER].send(...args);
  }

  @action
  update() {
    let { update } = this.args.positional[0];
    if (update) {
      update(this.send, this.state.context);
    }
  }

  /**
   * Lifecycle methods on Resource
   *
   */
  @action
  protected setup() {
    let {
      context,
      activities,
      actions,
      guards,
      delays,
      onTransition,
      owner,
      chart,
    } = this.args.positional?.[0];

    assert(ERROR_CHART_MISSING, chart);

    // This all could likely be refactored into one function but it could get a dice
    let allActions = gatherActions(chart, []);
    let actionsConfig = allActions.reduce((acc, actionName) => {
      assert(`Must implement function for the action: ${actionName}`, owner[actionName]);
      acc[actionName] = owner[actionName];
      return acc;
    }, {});

    let allGuards: Array<string> = gatherGuards(chart, []);
    let guardsConfig = allGuards.reduce((acc, guardName) => {
      assert(`Must implement function for the guard: ${guardName}`, owner[guardName]);
      acc[guardName] = owner[guardName];
      return acc;
    }, {});

    let allActivities: Array<string> = gatherActivities(chart, []);
    let activitiesConfig = allActivities.reduce((acc, activityName) => {
      assert(`Must implement function for the activity: ${activityName}`, owner[activityName]);
      acc[activityName] = owner[activityName];
      return acc;
    }, {});

    let allDelays: Array<string> = gatherDelays(chart, []);
    let delayConfig = allDelays.reduce((acc, delayName) => {
      assert(`Must implement function for the delay: ${delayName}`, owner[delayName]);
      acc[delayName] = owner[delayName];
      return acc;
    }, {});

    // Combine into one config object -- this also could be done better
    actions = actions || {};
    actions = { ...actionsConfig, ...actions };
    guards = guards || {};
    guards = { ...guardsConfig, ...guards };
    context = context || {};
    activities = activities || {};
    activities = { ...activitiesConfig, ...activities };
    delays = delays || {};
    delays = { ...delayConfig, ...delays };

    this[MACHINE] = Machine(chart).withContext(context).withConfig({
      guards,
      actions,
      activities,
      delays,
    });

    this[INTERPRETER] = interpret(this[MACHINE], {
      devTools: DEBUG,
      clock: {
        setTimeout(fn, ms) {
          return later.call(null, fn, ms);
        },
        clearTimeout(timer) {
          return cancel.call(null, timer);
        },
      },
    });

    this[INTERPRETER].onTransition((state) => {
      this.state = state;
    });

    if (onTransition) {
      this[INTERPRETER].onTransition(onTransition);
    }

    this[INTERPRETER].start();
  }

  protected teardown() {
    if (!this[INTERPRETER]) return;

    this[INTERPRETER].stop();
  }
}
