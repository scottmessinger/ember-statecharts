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
    {
      chart: MachineConfig<Context, Schema, Event>;
      config?: Partial<MachineOptions<Context, Event>>;
      context?: Context;
      initialState?: State<Context, Event>;
      onTransition?: StateListener<Context, Event, Schema, Typestate<Context>>;
    }
  ];
};

type SendArgs<Context, Schema extends StateSchema, Event extends EventObject> = Parameters<
  Interpreter<Context, Schema, Event>['send']
>;

/**
 *
  @use statechart = new Statechart(() => [{
    chart: chart,
    config: {},
    context: {},
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
    // withContext: Statechart<Context, Schema, Event>['withContext'];
    // withConfig: Statechart<Context, Schema, Event>['withConfig'];
    // onTransition: Statechart<Context, Schema, Event>['onTransition'];
  } {
    // if (!this[INTERPRETER]) {
    //   this._setupMachine();
    // }

    return {
      // For TypeScript, this is tricky because this is what is accessible at the call site
      // but typescript thinks the context is the class instance.
      //
      // To remedy, each property has to also exist on the class body under the same name
      state: this.state,
      send: this.send,

      /**
       * One Time methods
       * Currently disabled due to issues with the use/resource transform not allowing
       * the builder pattern
       *
       * If the transform is fixed, we can remove the protected visibility modifier
       * and uncomment out these three lines in a back-compat way for existing users
       */
      // withContext: this.withContext,
      // withConfig: this.withConfig,
      // onTransition: this.onTransition,
    };
  }

  @action
  protected withContext(context?: Context) {
    assert(ERROR_CANT_RECONFIGURE, !this[INTERPRETER]);

    if (context) {
      this[MACHINE] = this[MACHINE].withContext(context);
    }

    return this;
  }

  @action
  protected withConfig(config?: Partial<MachineOptions<Context, Event>>) {
    assert(ERROR_CANT_RECONFIGURE, !this[INTERPRETER]);

    if (config) {
      this[MACHINE] = this[MACHINE].withConfig(config);
    }

    return this;
  }

  @action
  protected onTransition(fn?: StateListener<Context, Event, Schema, Typestate<Context>>) {
    if (!this[INTERPRETER]) {
      this._setupMachine();
    }

    if (fn) {
      this[INTERPRETER].onTransition(fn);
    }

    return this;
  }

  /**
   * Private
   */

  @action
  send(...args: SendArgs<Context, Schema, Event>) {
    return this[INTERPRETER].send(...args);
  }

  @action
  private _setupMachine() {}

  /**
   * Lifecycle methods on Resource
   *
   */
  @action
  protected setup() {
    console.log('this.setup');
    let { chart, context, config, owner } = this.args.positional?.[0];

    assert(ERROR_CHART_MISSING, chart);

    let gatherActions = function (object, actionsArray) {
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

    let allActions: Array<string> = gatherActions(chart, []);
    let actionsConfig = allActions.reduce((acc, actionName) => {
      if (owner[actionName] === undefined) throw Error(`Must implement ${actionName}.`);
      acc[actionName] = owner[actionName];
      return acc;
    }, {});

    let actions = config?.actions || {};
    actions = { ...actionsConfig, ...actions };
    config = config || {};
    config = { ...config, ...{ actions: actions } };

    this[MACHINE] = Machine(chart).withContext(context).withConfig(config);

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

    this.onTransition(config?.onTransition);

    this[INTERPRETER].start();
  }

  protected teardown() {
    if (!this[INTERPRETER]) return;

    this[INTERPRETER].stop();
  }
}
