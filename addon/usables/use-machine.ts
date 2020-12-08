/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  interpret,
  createMachine,
  StateNode,
  EventObject,
  StateMachine,
  Typestate,
  MachineConfig,
  StateSchema,
  Interpreter,
  State,
  MachineOptions,
  StateValue,
  InterpreterOptions,
} from 'xstate';
import { StateListener } from 'xstate/lib/interpreter';

import { tracked } from '@glimmer/tracking';
import { DEBUG } from '@glimmer/env';
import { later, cancel } from '@ember/runloop';
import { getOwner, setOwner } from '@ember/application';
import { warn } from '@ember/debug';
import { action } from '@ember/object';

import { use, Resource } from 'ember-could-get-used-to-this';


export const ARGS_STATE_CHANGE_WARNING =
  'A change to passed `args` or a local state change triggered an update to a `useMachine`-usable. You can send a dedicated event to the machine or restart it so this is handled. This is done via the `.update`-hook of the `useMachine`-usable.';

export type Send<
  TContext,
  TStateSchema extends StateSchema,
  TEvent extends EventObject,
  TTypestate extends Typestate<TContext> = { value: any; context: TContext }
> = Interpreter<TContext, TStateSchema, TEvent, TTypestate>['send'];

export type UpdateFunction<
  TContext,
  TStateSchema extends StateSchema,
  TEvent extends EventObject,
  TTypestate extends Typestate<TContext> = { value: any; context: TContext }
> = (args: {
  machine: StateMachine<TContext, TStateSchema, TEvent, TTypestate>;
  context?: TContext;
  config?: Partial<MachineOptions<TContext, TEvent>>;
  send: Send<TContext, TStateSchema, TEvent, TTypestate>;
  restart: (initialState?: State<TContext, TEvent, TStateSchema, TTypestate> | StateValue) => void;
}) => void;

export type UsableStatechart<
  TContext,
  TStateSchema extends StateSchema,
  TEvent extends EventObject,
  TTypestate extends Typestate<TContext> = { value: any; context: TContext }
> =
  | MachineConfig<TContext, TStateSchema, TEvent>
  | StateMachine<TContext, TStateSchema, TEvent, TTypestate>;

export class Statechart<
  TContext,
  TStateSchema extends StateSchema,
  TEvent extends EventObject,
  TTypestate extends Typestate<TContext>
> extends Resource {
  @tracked service!: Interpreter<TContext, TStateSchema, TEvent, TTypestate>;
  @tracked _state!: State<TContext, TEvent, TStateSchema, TTypestate>;

  machine: StateMachine<TContext, TStateSchema, TEvent, TTypestate>;
  interpreterOptions: Partial<InterpreterOptions>;
  _onTransition: StateListener<TContext, TEvent, TStateSchema, TTypestate> | undefined = undefined;

  constructor(
    machine: UsableStatechart<TContext, TStateSchema, TEvent, TTypestate>,
    interpreterOptions: Partial<InterpreterOptions>,
    onTransition?: StateListener<TContext, TEvent, TStateSchema, TTypestate>
  ) {
    super(...arguments);

    machine = machine instanceof StateNode ? machine : createMachine(machine);

    this.machine = machine;
    this.interpreterOptions = interpreterOptions || {};
    this._onTransition = onTransition;
  }

  get state(): {
    state: State<TContext, TEvent, TStateSchema, TTypestate>;
    send: Send<TContext, TStateSchema, TEvent, TTypestate>;
    service: Interpreter<TContext, TStateSchema, TEvent, TTypestate>;
  } {
    return {
      state: this._state,
      send: this.service.send,
      service: this.service,
    };
  }

  get value() {
    // TODO: lazily call setup, as we don't know if the call site has .withContext or .withConfig
    return "foo";
  }

  @action
  send() {
    this.service.send(...arguments);
  }

  @action
  onTransition(fn: StateListener<TContext, TEvent, TStateSchema, TTypestate>) {
    this._onTransition = fn;
    return this;
  }


  @action
  withContext(context: TContext) {
    this._context = context;

    return this;
  }

  @action
  withConfig(config: Partial<MachineOptions<TContext, TEvent>>) {
    this._config = config;

    return this;
  }


  setup(
    setupOptions: {
      initialState?: State<TContext, TEvent, TStateSchema, TTypestate> | StateValue;
    } = {}
  ): void {
    const { state } = this.interpreterOptions;

    this.service = interpret(this.machine, {
      devTools: DEBUG,
      ...this.interpreterOptions,
      clock: {
        setTimeout(fn, ms) {
          return later.call(null, fn, ms);
        },
        clearTimeout(timer) {
          return cancel.call(null, timer);
        },
      },
    }).onTransition((state) => {
      this._state = state;
    });

    if (this._onTransition) {
      this.service.onTransition(this._onTransition);
    }

    this.service.start(setupOptions.initialState || state);
  }

  teardown(): void {
    this.service.stop();
  }
}
