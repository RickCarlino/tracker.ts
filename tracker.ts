type UNKNOWN_FUNC = () => void;

type ComputationCallback = (c: Computation) => void;

interface AutorunOpts { onError: UNKNOWN_FUNC; }

interface FlushOptions {
  _throwFirstError: boolean;
  throwFirstError: boolean;
  finishSynchronously: boolean;
}

interface Tracker {
  active: boolean
  currentComputation: Computation | null;
  _runFlush(opts: Partial<FlushOptions>): void;
  nonreactive(f: UNKNOWN_FUNC): void;
  flush(opts: FlushOptions): void;
  inFlush(): boolean;
  autorun(f: UNKNOWN_FUNC, options: AutorunOpts): Computation;
  onInvalidate(f: UNKNOWN_FUNC): void;
  afterFlush(f: UNKNOWN_FUNC): void;
}

const Tracker: Tracker = {
  active: false,
  currentComputation: null,
  // http://docs.meteor.com/#tracker_flush
  /**
   * Process all reactive updates immediately and ensure that all invalidated computations are rerun.
   */
  flush(options: FlushOptions) {
    Tracker._runFlush({
      finishSynchronously: true,
      throwFirstError: options && options._throwFirstError
    });
  },
  /** True if we are computing a computation now, either first time
   *  or recompute. This matches Tracker.active unless we are inside Tracker.nonreactive, which nullfies currentComputation even though an enclosing computation may still be running.
   */
  inFlush() {
    return inFlush;
  },
  // Run all pending computations and afterFlush callbacks. If we were not called
  // directly via Tracker.flush, this may return before they're all done to allow
  // the event loop to run a little before continuing.
  _runFlush(options?: Partial<FlushOptions>) {
    if (Tracker.inFlush()) {
      throw new Error("Can't call Tracker.flush while flushing");
    }

    if (inCompute) {
      throw new Error("Can't flush inside Tracker.autorun");
    }

    options = options || {};

    inFlush = true;
    willFlush = true;
    throwFirstError = !!options.throwFirstError;

    let recomputedCount = 0;
    let finishedTry = false;
    try {
      while (pendingComputations.length ||
        afterFlushCallbacks.length) {

        // recompute all pending computations
        while (pendingComputations.length) {
          const comp = pendingComputations.shift();
          if (!comp) {
            throw new Error("I should write a runtime assertion helper");
          }
          comp._recompute();
          if (comp._needsRecompute()) {
            pendingComputations.unshift(comp);
          }

          if (!options.finishSynchronously && ++recomputedCount > 1000) {
            finishedTry = true;
            return;
          }
        }

        if (afterFlushCallbacks.length) {
          // call one afterFlush callback, which may
          // invalidate more computations
          const func = afterFlushCallbacks.shift();
          try {
            func && func();
          } catch (e) {
            _throwOrLog("afterFlush", e as Error);
          }
        }
      }
      finishedTry = true;
    } finally {
      if (!finishedTry) {
        // we're erroring due to throwFirstError being true.
        inFlush = false; // needed before calling `Tracker.flush()` again
        // finish flushing
        Tracker._runFlush({
          finishSynchronously: !!options.finishSynchronously,
          throwFirstError: false
        });
      }
      willFlush = false;
      inFlush = false;
      if (pendingComputations.length || afterFlushCallbacks.length) {
        // We're yielding because we ran a bunch of computations and we aren't
        // required to finish synchronously, so we'd like to give the event loop a
        // chance. We should flush again soon.
        if (options.finishSynchronously) {
          throw new Error("still have more to do?");  // shouldn't happen
        }
        setTimeout(requireFlush, 10);
      }
    }
  },
  // http://docs.meteor.com/#tracker_autorun
  //
  // Run f(). Record its dependencies. Rerun it whenever the
  // dependencies change.
  //
  // Returns a new Computation, which is also passed to f.
  //
  // Links the computation to the current computation
  // so that it is stopped if the current computation is invalidated.
  /**
   * Run a function now and rerun it later whenever its dependencies
   * change. Returns a Computation object that can be used to stop or observe the
   * rerunning.
   * one argument: the Computation object that will be returned.
   * happens in the Computation. The only argument it receives is the Error
   * thrown. Defaults to the error being logged to the console.
   */
  autorun(f: UNKNOWN_FUNC, options: AutorunOpts) {
    options = options;

    constructingComputation = true;
    const c = new Computation(f, Tracker.currentComputation, options.onError);

    if (Tracker.active) {
      Tracker.onInvalidate(function () {
        c.stop();
      });
    }

    return c;
  },

  // http://docs.meteor.com/#tracker_nonreactive
  //
  // Run `f` with no current computation, returning the return value
  // of `f`. Used to turn off reactivity for the duration of `f`,
  // so that reactive data sources accessed by `f` will not result in any
  // computations being invalidated.
  /**
   * Run a function without tracking dependencies.
   */
  nonreactive(f) {
    const previous = Tracker.currentComputation;
    setCurrentComputation(null);
    try {
      return f();
    } finally {
      setCurrentComputation(previous);
    }
  },

  // http://docs.meteor.com/#tracker_oninvalidate
  /**
   * Registers a new [`onInvalidate`](#computation_oninvalidate) callback on the current computation (which must exist), to be called immediately when the current computation is invalidated or stopped.
   */
  onInvalidate(f) {
    if (!Tracker.active || !Tracker.currentComputation) {
      throw new Error("Tracker.onInvalidate requires a currentComputation");
    }
    Tracker.currentComputation.onInvalidate(f);
  },

  // http://docs.meteor.com/#tracker_afterflush
  /** Schedules a function to be called during the next flush, or
   *  later in the current flush if one is in progress, after all
   *  invalidated computations have been rerun. The function will
   *  be run once and not on subsequent flushes unless `afterFlush`
   *  is called again. */
  afterFlush(f) {
    afterFlushCallbacks.push(f);
    requireFlush();
  }
};

function setCurrentComputation(c: Computation | null) {
  Tracker.currentComputation = c;
  Tracker.active = !!c;
}

function _throwOrLog(from: string, e: Error) {
  if (throwFirstError) {
    throw e;
  } else {
    const printArgs = ["Exception from Tracker " + from + " function:"];
    if (e.stack && e.message && e.name) {
      const idx = e.stack.indexOf(e.message);
      if (idx < 0 || idx > e.name.length + 2) {
        printArgs.push(e.name + ": " + e.message);
      }
    }
    printArgs.push(e.stack ?? "NO STACK");
    console.log(printArgs.length);

    for (let i = 0; i < printArgs.length; i++) {
      console.log(printArgs[i]);
    }
  }
}

let nextId = 1;
// computations whose callbacks we should call at flush time
const pendingComputations: Computation[] = [];
// `true` if a Tracker.flush is scheduled, or if we are in Tracker.flush now
let willFlush = false;
// `true` if we are in Tracker.flush now
let inFlush = false;
// `true` if we are computing a computation now, either first time
// or recompute. This matches Tracker.active unless we are inside
// Tracker.nonreactive, which nullfies currentComputation even though
// an enclosing computation may still be running.
let inCompute = false;
// `true` if the `_throwFirstError` option was passed in to the call
// to Tracker.flush that we are in. When set, throw rather than log the
// first error encountered while flushing. Before throwing the error,
// finish flushing (from a finally block), logging any subsequent
// errors.
let throwFirstError = false;

const afterFlushCallbacks: (UNKNOWN_FUNC)[] = [];

function requireFlush() {
  if (!willFlush) {
    setTimeout(Tracker._runFlush, 0);
    willFlush = true;
  }
}

// Tracker.Computation constructor is visible but private
// (throws an error if you try to call it)
let constructingComputation = false;

//
// http://docs.meteor.com/#tracker_computation

/** A Computation object represents code that is repeatedly rerun
 * in response to
 * reactive data changes. Computations don't have return values; they just
 * perform actions, such as rerendering a template on the screen. Computations
 * are created using Tracker.autorun. Use stop to prevent further rerunning of a
 * computation.
 */
class Computation {
  private _func: ComputationCallback;
  private _onError: (e: unknown) => void;
  private _onInvalidateCallbacks: (ComputationCallback)[];
  private _onStopCallbacks: (ComputationCallback)[];
  private _recomputing: boolean;
  public firstRun: boolean;
  private invalidated: boolean;
  private stopped: boolean;
  public _id: number;
  public parent: Computation | null;

  constructor(f: ComputationCallback, parent: Computation | null, onError: UNKNOWN_FUNC) {
    if (!constructingComputation)
      throw new Error(
        "Tracker.Computation constructor is private; use Tracker.autorun");
    constructingComputation = false;

    // http://docs.meteor.com/#computation_stopped
    /** True if this computation has been stopped. */
    this.stopped = false;

    // http://docs.meteor.com/#computation_invalidated

    /** True if this computation has been invalidated (and not
     *  yet rerun), or if it has been stopped.*/
    this.invalidated = false;
    this.parent = parent;
    // http://docs.meteor.com/#computation_firstrun

    /** True during the initial run of the computation at the time
     *  `Tracker.autorun` is called, and false on subsequent reruns
     *  and at other times. */
    this.firstRun = true;
    this._id = nextId++;
    this._onInvalidateCallbacks = [];
    this._onStopCallbacks = [];
    this._func = f;
    this._onError = onError;
    this._recomputing = false;

    let errored = true;
    try {
      this._compute();
      errored = false;
    } finally {
      this.firstRun = false;
      if (errored)
        this.stop();
    }
  }

  // http://docs.meteor.com/#computation_oninvalidate

  /**
   * Registers `callback` to run when this computation is next invalidated, or runs it immediately if the computation is already invalidated. The callback is run exactly once and not upon future invalidations unless `onInvalidate` is called again after the computation becomes valid again.


   */
  onInvalidate(f: ComputationCallback) {
    if (this.invalidated) {
      Tracker.nonreactive(() => { f(this); });
    } else {
      this._onInvalidateCallbacks.push(f);
    }
  }

  /**
   * Registers `callback` to run when this computation is stopped, or runs it immediately if the computation is already stopped. The callback is run after any `onInvalidate` callbacks.


   */
  onStop(f: ComputationCallback) {
    if (this.stopped) {
      Tracker.nonreactive(() => f(this));
    } else {
      this._onStopCallbacks.push(f);
    }
  }

  // http://docs.meteor.com/#computation_invalidate

  /**
   * Invalidates this computation so that it will be rerun.

   */
  invalidate() {
    if (!this.invalidated) {
      // if we're currently in _recompute(), don't enqueue
      // ourselves, since we'll rerun immediately anyway.
      if (!this._recomputing && !this.stopped) {
        requireFlush();
        pendingComputations.push(this);
      }

      this.invalidated = true;

      // callbacks can't add callbacks, because
      // this.invalidated === true.
      for (let i = 0, f: ComputationCallback; f = this._onInvalidateCallbacks[i]; i++) {
        Tracker.nonreactive(() => {
          f(this);
        });
      }
      this._onInvalidateCallbacks = [];
    }
  }

  // http://docs.meteor.com/#computation_stop

  /**
   * Prevents this computation from rerunning.

   */
  stop() {
    if (!this.stopped) {
      this.stopped = true;
      this.invalidate();
      for (let i = 0, f: ComputationCallback; f = this._onStopCallbacks[i]; i++) {
        Tracker.nonreactive(() => {
          f(this);
        });
      }
      this._onStopCallbacks = [];
    }
  }

  _compute() {
    this.invalidated = false;

    const previous = Tracker.currentComputation;
    setCurrentComputation(this);
    const previousInCompute = inCompute;
    inCompute = true;
    try {
      this._func(this);
    } finally {
      setCurrentComputation(previous);
      inCompute = previousInCompute;
    }
  }

  _needsRecompute() {
    return this.invalidated && !this.stopped;
  }

  _recompute() {
    this._recomputing = true;
    try {
      if (this._needsRecompute()) {
        try {
          this._compute();
        } catch (e) {
          if (this._onError) {
            this._onError(e);
          } else {
            _throwOrLog("recompute", e as Error);
          }
        }
      }
    } finally {
      this._recomputing = false;
    }
  }

  /**
   * Process the reactive updates for this computation immediately
   * and ensure that the computation is rerun. The computation is rerun only
   * if it is invalidated.

   */
  flush() {
    if (this._recomputing)
      return;

    this._recompute();
  }

  /**
   * Causes the function inside this computation to run and
   * synchronously process all reactive updtes.

   */
  run() {
    this.invalidate();
    this.flush();
  }
};

// http://docs.meteor.com/#tracker_dependency
/** A Dependency represents an atomic unit of reactive data that a
 * computation might depend on. Reactive data sources such as Session or
 * Minimongo internally create different Dependency objects for different
 * pieces of data, each of which may be depended on by multiple computations.
 * When the data changes, the computations are invalidated. */
class Dependency {
  private _dependentsById: Record<number, Computation>;
  constructor() {
    this._dependentsById = Object.create(null);
  }

  // http://docs.meteor.com/#dependency_depend
  //
  // Adds `computation` to this set if it is not already
  // present. Returns true if `computation` is a new member of the set.
  // If no argument, defaults to currentComputation, or does nothing
  // if there is no currentComputation.

  /**
   * Declares that the current computation (or `fromComputation` if given) depends on `dependency`. The computation will be invalidated the next time `dependency` changes.
   If there is no current computation and `depend()` is called with no arguments, it does nothing and returns false.
   Returns true if the computation is a new dependent of `dependency` rather than an existing one.
   */
  depend(computation: Computation | null) {
    if (!computation) {
      if (!Tracker.active) {
        return false;
      }

      computation = Tracker.currentComputation;
    }
    // NOTE: The original implementation was not type safe.
    //       I added the runtime assertion later. -RC
    if (!computation) {
      throw new Error("Impossible? No Computation?");
    }
    const id = computation._id;
    if (!(id in this._dependentsById)) {
      this._dependentsById[id] = computation;
      computation.onInvalidate(() => {
        delete this._dependentsById[id];
      });
      return true;
    }
    return false;
  }

  // http://docs.meteor.com/#dependency_changed

  /**
   * Invalidate all dependent computations immediately and remove them as dependents.

   */
  changed() {
    for (const id in this._dependentsById)
      this._dependentsById[id].invalidate();
  }

  // http://docs.meteor.com/#dependency_hasdependents
  /** True if this Dependency has one or more dependent Computations,
   *  which would be invalidated if this Dependency were to change. */
  hasDependents() {
    for (const _id in this._dependentsById) { return true; }
    return false;
  }
};
