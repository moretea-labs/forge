var pf = { exports: {} }, Ou = {};
var Dr;
function hv() {
  if (Dr) return Ou;
  Dr = 1;
  var m = /* @__PURE__ */ Symbol.for("react.transitional.element"), x = /* @__PURE__ */ Symbol.for("react.fragment");
  function _(d, C, M) {
    var X = null;
    if (M !== void 0 && (X = "" + M), C.key !== void 0 && (X = "" + C.key), "key" in C) {
      M = {};
      for (var V in C)
        V !== "key" && (M[V] = C[V]);
    } else M = C;
    return C = M.ref, {
      $$typeof: m,
      type: d,
      key: X,
      ref: C !== void 0 ? C : null,
      props: M
    };
  }
  return Ou.Fragment = x, Ou.jsx = _, Ou.jsxs = _, Ou;
}
var Ur;
function vv() {
  return Ur || (Ur = 1, pf.exports = hv()), pf.exports;
}
var f = vv(), Af = { exports: {} }, K = {};
var Rr;
function yv() {
  if (Rr) return K;
  Rr = 1;
  var m = /* @__PURE__ */ Symbol.for("react.transitional.element"), x = /* @__PURE__ */ Symbol.for("react.portal"), _ = /* @__PURE__ */ Symbol.for("react.fragment"), d = /* @__PURE__ */ Symbol.for("react.strict_mode"), C = /* @__PURE__ */ Symbol.for("react.profiler"), M = /* @__PURE__ */ Symbol.for("react.consumer"), X = /* @__PURE__ */ Symbol.for("react.context"), V = /* @__PURE__ */ Symbol.for("react.forward_ref"), O = /* @__PURE__ */ Symbol.for("react.suspense"), z = /* @__PURE__ */ Symbol.for("react.memo"), D = /* @__PURE__ */ Symbol.for("react.lazy"), p = /* @__PURE__ */ Symbol.for("react.activity"), N = Symbol.iterator;
  function Y(r) {
    return r === null || typeof r != "object" ? null : (r = N && r[N] || r["@@iterator"], typeof r == "function" ? r : null);
  }
  var El = {
    isMounted: function() {
      return !1;
    },
    enqueueForceUpdate: function() {
    },
    enqueueReplaceState: function() {
    },
    enqueueSetState: function() {
    }
  }, xl = Object.assign, Nl = {};
  function cl(r, E, R) {
    this.props = r, this.context = E, this.refs = Nl, this.updater = R || El;
  }
  cl.prototype.isReactComponent = {}, cl.prototype.setState = function(r, E) {
    if (typeof r != "object" && typeof r != "function" && r != null)
      throw Error(
        "takes an object of state variables to update or a function which returns an object of state variables."
      );
    this.updater.enqueueSetState(this, r, E, "setState");
  }, cl.prototype.forceUpdate = function(r) {
    this.updater.enqueueForceUpdate(this, r, "forceUpdate");
  };
  function tl() {
  }
  tl.prototype = cl.prototype;
  function Rl(r, E, R) {
    this.props = r, this.context = E, this.refs = Nl, this.updater = R || El;
  }
  var Jl = Rl.prototype = new tl();
  Jl.constructor = Rl, xl(Jl, cl.prototype), Jl.isPureReactComponent = !0;
  var ht = Array.isArray;
  function Q() {
  }
  var $ = { H: null, A: null, T: null, S: null }, Cl = Object.prototype.hasOwnProperty;
  function wl(r, E, R) {
    var q = R.ref;
    return {
      $$typeof: m,
      type: r,
      key: E,
      ref: q !== void 0 ? q : null,
      props: R
    };
  }
  function We(r, E) {
    return wl(r.type, E, r.props);
  }
  function Mt(r) {
    return typeof r == "object" && r !== null && r.$$typeof === m;
  }
  function $l(r) {
    var E = { "=": "=0", ":": "=2" };
    return "$" + r.replace(/[=:]/g, function(R) {
      return E[R];
    });
  }
  var Ne = /\/+/g;
  function Ht(r, E) {
    return typeof r == "object" && r !== null && r.key != null ? $l("" + r.key) : E.toString(36);
  }
  function Et(r) {
    switch (r.status) {
      case "fulfilled":
        return r.value;
      case "rejected":
        throw r.reason;
      default:
        switch (typeof r.status == "string" ? r.then(Q, Q) : (r.status = "pending", r.then(
          function(E) {
            r.status === "pending" && (r.status = "fulfilled", r.value = E);
          },
          function(E) {
            r.status === "pending" && (r.status = "rejected", r.reason = E);
          }
        )), r.status) {
          case "fulfilled":
            return r.value;
          case "rejected":
            throw r.reason;
        }
    }
    throw r;
  }
  function A(r, E, R, q, J) {
    var k = typeof r;
    (k === "undefined" || k === "boolean") && (r = null);
    var il = !1;
    if (r === null) il = !0;
    else
      switch (k) {
        case "bigint":
        case "string":
        case "number":
          il = !0;
          break;
        case "object":
          switch (r.$$typeof) {
            case m:
            case x:
              il = !0;
              break;
            case D:
              return il = r._init, A(
                il(r._payload),
                E,
                R,
                q,
                J
              );
          }
      }
    if (il)
      return J = J(r), il = q === "" ? "." + Ht(r, 0) : q, ht(J) ? (R = "", il != null && (R = il.replace(Ne, "$&/") + "/"), A(J, E, R, "", function(Ha) {
        return Ha;
      })) : J != null && (Mt(J) && (J = We(
        J,
        R + (J.key == null || r && r.key === J.key ? "" : ("" + J.key).replace(
          Ne,
          "$&/"
        ) + "/") + il
      )), E.push(J)), 1;
    il = 0;
    var Zl = q === "" ? "." : q + ":";
    if (ht(r))
      for (var zl = 0; zl < r.length; zl++)
        q = r[zl], k = Zl + Ht(q, zl), il += A(
          q,
          E,
          R,
          k,
          J
        );
    else if (zl = Y(r), typeof zl == "function")
      for (r = zl.call(r), zl = 0; !(q = r.next()).done; )
        q = q.value, k = Zl + Ht(q, zl++), il += A(
          q,
          E,
          R,
          k,
          J
        );
    else if (k === "object") {
      if (typeof r.then == "function")
        return A(
          Et(r),
          E,
          R,
          q,
          J
        );
      throw E = String(r), Error(
        "Objects are not valid as a React child (found: " + (E === "[object Object]" ? "object with keys {" + Object.keys(r).join(", ") + "}" : E) + "). If you meant to render a collection of children, use an array instead."
      );
    }
    return il;
  }
  function U(r, E, R) {
    if (r == null) return r;
    var q = [], J = 0;
    return A(r, q, "", "", function(k) {
      return E.call(R, k, J++);
    }), q;
  }
  function Z(r) {
    if (r._status === -1) {
      var E = r._result;
      E = E(), E.then(
        function(R) {
          (r._status === 0 || r._status === -1) && (r._status = 1, r._result = R);
        },
        function(R) {
          (r._status === 0 || r._status === -1) && (r._status = 2, r._result = R);
        }
      ), r._status === -1 && (r._status = 0, r._result = E);
    }
    if (r._status === 1) return r._result.default;
    throw r._result;
  }
  var ol = typeof reportError == "function" ? reportError : function(r) {
    if (typeof window == "object" && typeof window.ErrorEvent == "function") {
      var E = new window.ErrorEvent("error", {
        bubbles: !0,
        cancelable: !0,
        message: typeof r == "object" && r !== null && typeof r.message == "string" ? String(r.message) : String(r),
        error: r
      });
      if (!window.dispatchEvent(E)) return;
    } else if (typeof process == "object" && typeof process.emit == "function") {
      process.emit("uncaughtException", r);
      return;
    }
    console.error(r);
  }, hl = {
    map: U,
    forEach: function(r, E, R) {
      U(
        r,
        function() {
          E.apply(this, arguments);
        },
        R
      );
    },
    count: function(r) {
      var E = 0;
      return U(r, function() {
        E++;
      }), E;
    },
    toArray: function(r) {
      return U(r, function(E) {
        return E;
      }) || [];
    },
    only: function(r) {
      if (!Mt(r))
        throw Error(
          "React.Children.only expected to receive a single React element child."
        );
      return r;
    }
  };
  return K.Activity = p, K.Children = hl, K.Component = cl, K.Fragment = _, K.Profiler = C, K.PureComponent = Rl, K.StrictMode = d, K.Suspense = O, K.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = $, K.__COMPILER_RUNTIME = {
    __proto__: null,
    c: function(r) {
      return $.H.useMemoCache(r);
    }
  }, K.cache = function(r) {
    return function() {
      return r.apply(null, arguments);
    };
  }, K.cacheSignal = function() {
    return null;
  }, K.cloneElement = function(r, E, R) {
    if (r == null)
      throw Error(
        "The argument must be a React element, but you passed " + r + "."
      );
    var q = xl({}, r.props), J = r.key;
    if (E != null)
      for (k in E.key !== void 0 && (J = "" + E.key), E)
        !Cl.call(E, k) || k === "key" || k === "__self" || k === "__source" || k === "ref" && E.ref === void 0 || (q[k] = E[k]);
    var k = arguments.length - 2;
    if (k === 1) q.children = R;
    else if (1 < k) {
      for (var il = Array(k), Zl = 0; Zl < k; Zl++)
        il[Zl] = arguments[Zl + 2];
      q.children = il;
    }
    return wl(r.type, J, q);
  }, K.createContext = function(r) {
    return r = {
      $$typeof: X,
      _currentValue: r,
      _currentValue2: r,
      _threadCount: 0,
      Provider: null,
      Consumer: null
    }, r.Provider = r, r.Consumer = {
      $$typeof: M,
      _context: r
    }, r;
  }, K.createElement = function(r, E, R) {
    var q, J = {}, k = null;
    if (E != null)
      for (q in E.key !== void 0 && (k = "" + E.key), E)
        Cl.call(E, q) && q !== "key" && q !== "__self" && q !== "__source" && (J[q] = E[q]);
    var il = arguments.length - 2;
    if (il === 1) J.children = R;
    else if (1 < il) {
      for (var Zl = Array(il), zl = 0; zl < il; zl++)
        Zl[zl] = arguments[zl + 2];
      J.children = Zl;
    }
    if (r && r.defaultProps)
      for (q in il = r.defaultProps, il)
        J[q] === void 0 && (J[q] = il[q]);
    return wl(r, k, J);
  }, K.createRef = function() {
    return { current: null };
  }, K.forwardRef = function(r) {
    return { $$typeof: V, render: r };
  }, K.isValidElement = Mt, K.lazy = function(r) {
    return {
      $$typeof: D,
      _payload: { _status: -1, _result: r },
      _init: Z
    };
  }, K.memo = function(r, E) {
    return {
      $$typeof: z,
      type: r,
      compare: E === void 0 ? null : E
    };
  }, K.startTransition = function(r) {
    var E = $.T, R = {};
    $.T = R;
    try {
      var q = r(), J = $.S;
      J !== null && J(R, q), typeof q == "object" && q !== null && typeof q.then == "function" && q.then(Q, ol);
    } catch (k) {
      ol(k);
    } finally {
      E !== null && R.types !== null && (E.types = R.types), $.T = E;
    }
  }, K.unstable_useCacheRefresh = function() {
    return $.H.useCacheRefresh();
  }, K.use = function(r) {
    return $.H.use(r);
  }, K.useActionState = function(r, E, R) {
    return $.H.useActionState(r, E, R);
  }, K.useCallback = function(r, E) {
    return $.H.useCallback(r, E);
  }, K.useContext = function(r) {
    return $.H.useContext(r);
  }, K.useDebugValue = function() {
  }, K.useDeferredValue = function(r, E) {
    return $.H.useDeferredValue(r, E);
  }, K.useEffect = function(r, E) {
    return $.H.useEffect(r, E);
  }, K.useEffectEvent = function(r) {
    return $.H.useEffectEvent(r);
  }, K.useId = function() {
    return $.H.useId();
  }, K.useImperativeHandle = function(r, E, R) {
    return $.H.useImperativeHandle(r, E, R);
  }, K.useInsertionEffect = function(r, E) {
    return $.H.useInsertionEffect(r, E);
  }, K.useLayoutEffect = function(r, E) {
    return $.H.useLayoutEffect(r, E);
  }, K.useMemo = function(r, E) {
    return $.H.useMemo(r, E);
  }, K.useOptimistic = function(r, E) {
    return $.H.useOptimistic(r, E);
  }, K.useReducer = function(r, E, R) {
    return $.H.useReducer(r, E, R);
  }, K.useRef = function(r) {
    return $.H.useRef(r);
  }, K.useState = function(r) {
    return $.H.useState(r);
  }, K.useSyncExternalStore = function(r, E, R) {
    return $.H.useSyncExternalStore(
      r,
      E,
      R
    );
  }, K.useTransition = function() {
    return $.H.useTransition();
  }, K.version = "19.2.8", K;
}
var Cr;
function Nf() {
  return Cr || (Cr = 1, Af.exports = yv()), Af.exports;
}
var Sl = Nf(), zf = { exports: {} }, _u = {}, Tf = { exports: {} }, jf = {};
var Hr;
function gv() {
  return Hr || (Hr = 1, (function(m) {
    function x(A, U) {
      var Z = A.length;
      A.push(U);
      l: for (; 0 < Z; ) {
        var ol = Z - 1 >>> 1, hl = A[ol];
        if (0 < C(hl, U))
          A[ol] = U, A[Z] = hl, Z = ol;
        else break l;
      }
    }
    function _(A) {
      return A.length === 0 ? null : A[0];
    }
    function d(A) {
      if (A.length === 0) return null;
      var U = A[0], Z = A.pop();
      if (Z !== U) {
        A[0] = Z;
        l: for (var ol = 0, hl = A.length, r = hl >>> 1; ol < r; ) {
          var E = 2 * (ol + 1) - 1, R = A[E], q = E + 1, J = A[q];
          if (0 > C(R, Z))
            q < hl && 0 > C(J, R) ? (A[ol] = J, A[q] = Z, ol = q) : (A[ol] = R, A[E] = Z, ol = E);
          else if (q < hl && 0 > C(J, Z))
            A[ol] = J, A[q] = Z, ol = q;
          else break l;
        }
      }
      return U;
    }
    function C(A, U) {
      var Z = A.sortIndex - U.sortIndex;
      return Z !== 0 ? Z : A.id - U.id;
    }
    if (m.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
      var M = performance;
      m.unstable_now = function() {
        return M.now();
      };
    } else {
      var X = Date, V = X.now();
      m.unstable_now = function() {
        return X.now() - V;
      };
    }
    var O = [], z = [], D = 1, p = null, N = 3, Y = !1, El = !1, xl = !1, Nl = !1, cl = typeof setTimeout == "function" ? setTimeout : null, tl = typeof clearTimeout == "function" ? clearTimeout : null, Rl = typeof setImmediate < "u" ? setImmediate : null;
    function Jl(A) {
      for (var U = _(z); U !== null; ) {
        if (U.callback === null) d(z);
        else if (U.startTime <= A)
          d(z), U.sortIndex = U.expirationTime, x(O, U);
        else break;
        U = _(z);
      }
    }
    function ht(A) {
      if (xl = !1, Jl(A), !El)
        if (_(O) !== null)
          El = !0, Q || (Q = !0, $l());
        else {
          var U = _(z);
          U !== null && Et(ht, U.startTime - A);
        }
    }
    var Q = !1, $ = -1, Cl = 5, wl = -1;
    function We() {
      return Nl ? !0 : !(m.unstable_now() - wl < Cl);
    }
    function Mt() {
      if (Nl = !1, Q) {
        var A = m.unstable_now();
        wl = A;
        var U = !0;
        try {
          l: {
            El = !1, xl && (xl = !1, tl($), $ = -1), Y = !0;
            var Z = N;
            try {
              t: {
                for (Jl(A), p = _(O); p !== null && !(p.expirationTime > A && We()); ) {
                  var ol = p.callback;
                  if (typeof ol == "function") {
                    p.callback = null, N = p.priorityLevel;
                    var hl = ol(
                      p.expirationTime <= A
                    );
                    if (A = m.unstable_now(), typeof hl == "function") {
                      p.callback = hl, Jl(A), U = !0;
                      break t;
                    }
                    p === _(O) && d(O), Jl(A);
                  } else d(O);
                  p = _(O);
                }
                if (p !== null) U = !0;
                else {
                  var r = _(z);
                  r !== null && Et(
                    ht,
                    r.startTime - A
                  ), U = !1;
                }
              }
              break l;
            } finally {
              p = null, N = Z, Y = !1;
            }
            U = void 0;
          }
        } finally {
          U ? $l() : Q = !1;
        }
      }
    }
    var $l;
    if (typeof Rl == "function")
      $l = function() {
        Rl(Mt);
      };
    else if (typeof MessageChannel < "u") {
      var Ne = new MessageChannel(), Ht = Ne.port2;
      Ne.port1.onmessage = Mt, $l = function() {
        Ht.postMessage(null);
      };
    } else
      $l = function() {
        cl(Mt, 0);
      };
    function Et(A, U) {
      $ = cl(function() {
        A(m.unstable_now());
      }, U);
    }
    m.unstable_IdlePriority = 5, m.unstable_ImmediatePriority = 1, m.unstable_LowPriority = 4, m.unstable_NormalPriority = 3, m.unstable_Profiling = null, m.unstable_UserBlockingPriority = 2, m.unstable_cancelCallback = function(A) {
      A.callback = null;
    }, m.unstable_forceFrameRate = function(A) {
      0 > A || 125 < A ? console.error(
        "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
      ) : Cl = 0 < A ? Math.floor(1e3 / A) : 5;
    }, m.unstable_getCurrentPriorityLevel = function() {
      return N;
    }, m.unstable_next = function(A) {
      switch (N) {
        case 1:
        case 2:
        case 3:
          var U = 3;
          break;
        default:
          U = N;
      }
      var Z = N;
      N = U;
      try {
        return A();
      } finally {
        N = Z;
      }
    }, m.unstable_requestPaint = function() {
      Nl = !0;
    }, m.unstable_runWithPriority = function(A, U) {
      switch (A) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
          break;
        default:
          A = 3;
      }
      var Z = N;
      N = A;
      try {
        return U();
      } finally {
        N = Z;
      }
    }, m.unstable_scheduleCallback = function(A, U, Z) {
      var ol = m.unstable_now();
      switch (typeof Z == "object" && Z !== null ? (Z = Z.delay, Z = typeof Z == "number" && 0 < Z ? ol + Z : ol) : Z = ol, A) {
        case 1:
          var hl = -1;
          break;
        case 2:
          hl = 250;
          break;
        case 5:
          hl = 1073741823;
          break;
        case 4:
          hl = 1e4;
          break;
        default:
          hl = 5e3;
      }
      return hl = Z + hl, A = {
        id: D++,
        callback: U,
        priorityLevel: A,
        startTime: Z,
        expirationTime: hl,
        sortIndex: -1
      }, Z > ol ? (A.sortIndex = Z, x(z, A), _(O) === null && A === _(z) && (xl ? (tl($), $ = -1) : xl = !0, Et(ht, Z - ol))) : (A.sortIndex = hl, x(O, A), El || Y || (El = !0, Q || (Q = !0, $l()))), A;
    }, m.unstable_shouldYield = We, m.unstable_wrapCallback = function(A) {
      var U = N;
      return function() {
        var Z = N;
        N = U;
        try {
          return A.apply(this, arguments);
        } finally {
          N = Z;
        }
      };
    };
  })(jf)), jf;
}
var qr;
function Sv() {
  return qr || (qr = 1, Tf.exports = gv()), Tf.exports;
}
var Ef = { exports: {} }, Ql = {};
var Br;
function bv() {
  if (Br) return Ql;
  Br = 1;
  var m = Nf();
  function x(O) {
    var z = "https://react.dev/errors/" + O;
    if (1 < arguments.length) {
      z += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var D = 2; D < arguments.length; D++)
        z += "&args[]=" + encodeURIComponent(arguments[D]);
    }
    return "Minified React error #" + O + "; visit " + z + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function _() {
  }
  var d = {
    d: {
      f: _,
      r: function() {
        throw Error(x(522));
      },
      D: _,
      C: _,
      L: _,
      m: _,
      X: _,
      S: _,
      M: _
    },
    p: 0,
    findDOMNode: null
  }, C = /* @__PURE__ */ Symbol.for("react.portal");
  function M(O, z, D) {
    var p = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: C,
      key: p == null ? null : "" + p,
      children: O,
      containerInfo: z,
      implementation: D
    };
  }
  var X = m.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function V(O, z) {
    if (O === "font") return "";
    if (typeof z == "string")
      return z === "use-credentials" ? z : "";
  }
  return Ql.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = d, Ql.createPortal = function(O, z) {
    var D = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!z || z.nodeType !== 1 && z.nodeType !== 9 && z.nodeType !== 11)
      throw Error(x(299));
    return M(O, z, null, D);
  }, Ql.flushSync = function(O) {
    var z = X.T, D = d.p;
    try {
      if (X.T = null, d.p = 2, O) return O();
    } finally {
      X.T = z, d.p = D, d.d.f();
    }
  }, Ql.preconnect = function(O, z) {
    typeof O == "string" && (z ? (z = z.crossOrigin, z = typeof z == "string" ? z === "use-credentials" ? z : "" : void 0) : z = null, d.d.C(O, z));
  }, Ql.prefetchDNS = function(O) {
    typeof O == "string" && d.d.D(O);
  }, Ql.preinit = function(O, z) {
    if (typeof O == "string" && z && typeof z.as == "string") {
      var D = z.as, p = V(D, z.crossOrigin), N = typeof z.integrity == "string" ? z.integrity : void 0, Y = typeof z.fetchPriority == "string" ? z.fetchPriority : void 0;
      D === "style" ? d.d.S(
        O,
        typeof z.precedence == "string" ? z.precedence : void 0,
        {
          crossOrigin: p,
          integrity: N,
          fetchPriority: Y
        }
      ) : D === "script" && d.d.X(O, {
        crossOrigin: p,
        integrity: N,
        fetchPriority: Y,
        nonce: typeof z.nonce == "string" ? z.nonce : void 0
      });
    }
  }, Ql.preinitModule = function(O, z) {
    if (typeof O == "string")
      if (typeof z == "object" && z !== null) {
        if (z.as == null || z.as === "script") {
          var D = V(
            z.as,
            z.crossOrigin
          );
          d.d.M(O, {
            crossOrigin: D,
            integrity: typeof z.integrity == "string" ? z.integrity : void 0,
            nonce: typeof z.nonce == "string" ? z.nonce : void 0
          });
        }
      } else z == null && d.d.M(O);
  }, Ql.preload = function(O, z) {
    if (typeof O == "string" && typeof z == "object" && z !== null && typeof z.as == "string") {
      var D = z.as, p = V(D, z.crossOrigin);
      d.d.L(O, D, {
        crossOrigin: p,
        integrity: typeof z.integrity == "string" ? z.integrity : void 0,
        nonce: typeof z.nonce == "string" ? z.nonce : void 0,
        type: typeof z.type == "string" ? z.type : void 0,
        fetchPriority: typeof z.fetchPriority == "string" ? z.fetchPriority : void 0,
        referrerPolicy: typeof z.referrerPolicy == "string" ? z.referrerPolicy : void 0,
        imageSrcSet: typeof z.imageSrcSet == "string" ? z.imageSrcSet : void 0,
        imageSizes: typeof z.imageSizes == "string" ? z.imageSizes : void 0,
        media: typeof z.media == "string" ? z.media : void 0
      });
    }
  }, Ql.preloadModule = function(O, z) {
    if (typeof O == "string")
      if (z) {
        var D = V(z.as, z.crossOrigin);
        d.d.m(O, {
          as: typeof z.as == "string" && z.as !== "script" ? z.as : void 0,
          crossOrigin: D,
          integrity: typeof z.integrity == "string" ? z.integrity : void 0
        });
      } else d.d.m(O);
  }, Ql.requestFormReset = function(O) {
    d.d.r(O);
  }, Ql.unstable_batchedUpdates = function(O, z) {
    return O(z);
  }, Ql.useFormState = function(O, z, D) {
    return X.H.useFormState(O, z, D);
  }, Ql.useFormStatus = function() {
    return X.H.useHostTransitionStatus();
  }, Ql.version = "19.2.8", Ql;
}
var Yr;
function pv() {
  if (Yr) return Ef.exports;
  Yr = 1;
  function m() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(m);
      } catch (x) {
        console.error(x);
      }
  }
  return m(), Ef.exports = bv(), Ef.exports;
}
var Gr;
function Av() {
  if (Gr) return _u;
  Gr = 1;
  var m = Sv(), x = Nf(), _ = pv();
  function d(l) {
    var t = "https://react.dev/errors/" + l;
    if (1 < arguments.length) {
      t += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var e = 2; e < arguments.length; e++)
        t += "&args[]=" + encodeURIComponent(arguments[e]);
    }
    return "Minified React error #" + l + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function C(l) {
    return !(!l || l.nodeType !== 1 && l.nodeType !== 9 && l.nodeType !== 11);
  }
  function M(l) {
    var t = l, e = l;
    if (l.alternate) for (; t.return; ) t = t.return;
    else {
      l = t;
      do
        t = l, (t.flags & 4098) !== 0 && (e = t.return), l = t.return;
      while (l);
    }
    return t.tag === 3 ? e : null;
  }
  function X(l) {
    if (l.tag === 13) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function V(l) {
    if (l.tag === 31) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function O(l) {
    if (M(l) !== l)
      throw Error(d(188));
  }
  function z(l) {
    var t = l.alternate;
    if (!t) {
      if (t = M(l), t === null) throw Error(d(188));
      return t !== l ? null : l;
    }
    for (var e = l, a = t; ; ) {
      var u = e.return;
      if (u === null) break;
      var n = u.alternate;
      if (n === null) {
        if (a = u.return, a !== null) {
          e = a;
          continue;
        }
        break;
      }
      if (u.child === n.child) {
        for (n = u.child; n; ) {
          if (n === e) return O(u), l;
          if (n === a) return O(u), t;
          n = n.sibling;
        }
        throw Error(d(188));
      }
      if (e.return !== a.return) e = u, a = n;
      else {
        for (var i = !1, c = u.child; c; ) {
          if (c === e) {
            i = !0, e = u, a = n;
            break;
          }
          if (c === a) {
            i = !0, a = u, e = n;
            break;
          }
          c = c.sibling;
        }
        if (!i) {
          for (c = n.child; c; ) {
            if (c === e) {
              i = !0, e = n, a = u;
              break;
            }
            if (c === a) {
              i = !0, a = n, e = u;
              break;
            }
            c = c.sibling;
          }
          if (!i) throw Error(d(189));
        }
      }
      if (e.alternate !== a) throw Error(d(190));
    }
    if (e.tag !== 3) throw Error(d(188));
    return e.stateNode.current === e ? l : t;
  }
  function D(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l;
    for (l = l.child; l !== null; ) {
      if (t = D(l), t !== null) return t;
      l = l.sibling;
    }
    return null;
  }
  var p = Object.assign, N = /* @__PURE__ */ Symbol.for("react.element"), Y = /* @__PURE__ */ Symbol.for("react.transitional.element"), El = /* @__PURE__ */ Symbol.for("react.portal"), xl = /* @__PURE__ */ Symbol.for("react.fragment"), Nl = /* @__PURE__ */ Symbol.for("react.strict_mode"), cl = /* @__PURE__ */ Symbol.for("react.profiler"), tl = /* @__PURE__ */ Symbol.for("react.consumer"), Rl = /* @__PURE__ */ Symbol.for("react.context"), Jl = /* @__PURE__ */ Symbol.for("react.forward_ref"), ht = /* @__PURE__ */ Symbol.for("react.suspense"), Q = /* @__PURE__ */ Symbol.for("react.suspense_list"), $ = /* @__PURE__ */ Symbol.for("react.memo"), Cl = /* @__PURE__ */ Symbol.for("react.lazy"), wl = /* @__PURE__ */ Symbol.for("react.activity"), We = /* @__PURE__ */ Symbol.for("react.memo_cache_sentinel"), Mt = Symbol.iterator;
  function $l(l) {
    return l === null || typeof l != "object" ? null : (l = Mt && l[Mt] || l["@@iterator"], typeof l == "function" ? l : null);
  }
  var Ne = /* @__PURE__ */ Symbol.for("react.client.reference");
  function Ht(l) {
    if (l == null) return null;
    if (typeof l == "function")
      return l.$$typeof === Ne ? null : l.displayName || l.name || null;
    if (typeof l == "string") return l;
    switch (l) {
      case xl:
        return "Fragment";
      case cl:
        return "Profiler";
      case Nl:
        return "StrictMode";
      case ht:
        return "Suspense";
      case Q:
        return "SuspenseList";
      case wl:
        return "Activity";
    }
    if (typeof l == "object")
      switch (l.$$typeof) {
        case El:
          return "Portal";
        case Rl:
          return l.displayName || "Context";
        case tl:
          return (l._context.displayName || "Context") + ".Consumer";
        case Jl:
          var t = l.render;
          return l = l.displayName, l || (l = t.displayName || t.name || "", l = l !== "" ? "ForwardRef(" + l + ")" : "ForwardRef"), l;
        case $:
          return t = l.displayName || null, t !== null ? t : Ht(l.type) || "Memo";
        case Cl:
          t = l._payload, l = l._init;
          try {
            return Ht(l(t));
          } catch {
          }
      }
    return null;
  }
  var Et = Array.isArray, A = x.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, U = _.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, Z = {
    pending: !1,
    data: null,
    method: null,
    action: null
  }, ol = [], hl = -1;
  function r(l) {
    return { current: l };
  }
  function E(l) {
    0 > hl || (l.current = ol[hl], ol[hl] = null, hl--);
  }
  function R(l, t) {
    hl++, ol[hl] = l.current, l.current = t;
  }
  var q = r(null), J = r(null), k = r(null), il = r(null);
  function Zl(l, t) {
    switch (R(k, t), R(J, l), R(q, null), t.nodeType) {
      case 9:
      case 11:
        l = (l = t.documentElement) && (l = l.namespaceURI) ? lr(l) : 0;
        break;
      default:
        if (l = t.tagName, t = t.namespaceURI)
          t = lr(t), l = tr(t, l);
        else
          switch (l) {
            case "svg":
              l = 1;
              break;
            case "math":
              l = 2;
              break;
            default:
              l = 0;
          }
    }
    E(q), R(q, l);
  }
  function zl() {
    E(q), E(J), E(k);
  }
  function Ha(l) {
    l.memoizedState !== null && R(il, l);
    var t = q.current, e = tr(t, l.type);
    t !== e && (R(J, l), R(q, e));
  }
  function Uu(l) {
    J.current === l && (E(q), E(J)), il.current === l && (E(il), ju._currentValue = Z);
  }
  var ti, _f;
  function Oe(l) {
    if (ti === void 0)
      try {
        throw Error();
      } catch (e) {
        var t = e.stack.trim().match(/\n( *(at )?)/);
        ti = t && t[1] || "", _f = -1 < e.stack.indexOf(`
    at`) ? " (<anonymous>)" : -1 < e.stack.indexOf("@") ? "@unknown:0:0" : "";
      }
    return `
` + ti + l + _f;
  }
  var ei = !1;
  function ai(l, t) {
    if (!l || ei) return "";
    ei = !0;
    var e = Error.prepareStackTrace;
    Error.prepareStackTrace = void 0;
    try {
      var a = {
        DetermineComponentFrameRoot: function() {
          try {
            if (t) {
              var j = function() {
                throw Error();
              };
              if (Object.defineProperty(j.prototype, "props", {
                set: function() {
                  throw Error();
                }
              }), typeof Reflect == "object" && Reflect.construct) {
                try {
                  Reflect.construct(j, []);
                } catch (S) {
                  var g = S;
                }
                Reflect.construct(l, [], j);
              } else {
                try {
                  j.call();
                } catch (S) {
                  g = S;
                }
                l.call(j.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (S) {
                g = S;
              }
              (j = l()) && typeof j.catch == "function" && j.catch(function() {
              });
            }
          } catch (S) {
            if (S && g && typeof S.stack == "string")
              return [S.stack, g.stack];
          }
          return [null, null];
        }
      };
      a.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
      var u = Object.getOwnPropertyDescriptor(
        a.DetermineComponentFrameRoot,
        "name"
      );
      u && u.configurable && Object.defineProperty(
        a.DetermineComponentFrameRoot,
        "name",
        { value: "DetermineComponentFrameRoot" }
      );
      var n = a.DetermineComponentFrameRoot(), i = n[0], c = n[1];
      if (i && c) {
        var s = i.split(`
`), y = c.split(`
`);
        for (u = a = 0; a < s.length && !s[a].includes("DetermineComponentFrameRoot"); )
          a++;
        for (; u < y.length && !y[u].includes(
          "DetermineComponentFrameRoot"
        ); )
          u++;
        if (a === s.length || u === y.length)
          for (a = s.length - 1, u = y.length - 1; 1 <= a && 0 <= u && s[a] !== y[u]; )
            u--;
        for (; 1 <= a && 0 <= u; a--, u--)
          if (s[a] !== y[u]) {
            if (a !== 1 || u !== 1)
              do
                if (a--, u--, 0 > u || s[a] !== y[u]) {
                  var b = `
` + s[a].replace(" at new ", " at ");
                  return l.displayName && b.includes("<anonymous>") && (b = b.replace("<anonymous>", l.displayName)), b;
                }
              while (1 <= a && 0 <= u);
            break;
          }
      }
    } finally {
      ei = !1, Error.prepareStackTrace = e;
    }
    return (e = l ? l.displayName || l.name : "") ? Oe(e) : "";
  }
  function Kr(l, t) {
    switch (l.tag) {
      case 26:
      case 27:
      case 5:
        return Oe(l.type);
      case 16:
        return Oe("Lazy");
      case 13:
        return l.child !== t && t !== null ? Oe("Suspense Fallback") : Oe("Suspense");
      case 19:
        return Oe("SuspenseList");
      case 0:
      case 15:
        return ai(l.type, !1);
      case 11:
        return ai(l.type.render, !1);
      case 1:
        return ai(l.type, !0);
      case 31:
        return Oe("Activity");
      default:
        return "";
    }
  }
  function Mf(l) {
    try {
      var t = "", e = null;
      do
        t += Kr(l, e), e = l, l = l.return;
      while (l);
      return t;
    } catch (a) {
      return `
Error generating stack: ` + a.message + `
` + a.stack;
    }
  }
  var ui = Object.prototype.hasOwnProperty, ni = m.unstable_scheduleCallback, ii = m.unstable_cancelCallback, Jr = m.unstable_shouldYield, wr = m.unstable_requestPaint, ut = m.unstable_now, $r = m.unstable_getCurrentPriorityLevel, Df = m.unstable_ImmediatePriority, Uf = m.unstable_UserBlockingPriority, Ru = m.unstable_NormalPriority, Wr = m.unstable_LowPriority, Rf = m.unstable_IdlePriority, kr = m.log, Fr = m.unstable_setDisableYieldValue, qa = null, nt = null;
  function te(l) {
    if (typeof kr == "function" && Fr(l), nt && typeof nt.setStrictMode == "function")
      try {
        nt.setStrictMode(qa, l);
      } catch {
      }
  }
  var it = Math.clz32 ? Math.clz32 : lm, Ir = Math.log, Pr = Math.LN2;
  function lm(l) {
    return l >>>= 0, l === 0 ? 32 : 31 - (Ir(l) / Pr | 0) | 0;
  }
  var Cu = 256, Hu = 262144, qu = 4194304;
  function _e(l) {
    var t = l & 42;
    if (t !== 0) return t;
    switch (l & -l) {
      case 1:
        return 1;
      case 2:
        return 2;
      case 4:
        return 4;
      case 8:
        return 8;
      case 16:
        return 16;
      case 32:
        return 32;
      case 64:
        return 64;
      case 128:
        return 128;
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
        return l & 261888;
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return l & 3932160;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        return l & 62914560;
      case 67108864:
        return 67108864;
      case 134217728:
        return 134217728;
      case 268435456:
        return 268435456;
      case 536870912:
        return 536870912;
      case 1073741824:
        return 0;
      default:
        return l;
    }
  }
  function Bu(l, t, e) {
    var a = l.pendingLanes;
    if (a === 0) return 0;
    var u = 0, n = l.suspendedLanes, i = l.pingedLanes;
    l = l.warmLanes;
    var c = a & 134217727;
    return c !== 0 ? (a = c & ~n, a !== 0 ? u = _e(a) : (i &= c, i !== 0 ? u = _e(i) : e || (e = c & ~l, e !== 0 && (u = _e(e))))) : (c = a & ~n, c !== 0 ? u = _e(c) : i !== 0 ? u = _e(i) : e || (e = a & ~l, e !== 0 && (u = _e(e)))), u === 0 ? 0 : t !== 0 && t !== u && (t & n) === 0 && (n = u & -u, e = t & -t, n >= e || n === 32 && (e & 4194048) !== 0) ? t : u;
  }
  function Ba(l, t) {
    return (l.pendingLanes & ~(l.suspendedLanes & ~l.pingedLanes) & t) === 0;
  }
  function tm(l, t) {
    switch (l) {
      case 1:
      case 2:
      case 4:
      case 8:
      case 64:
        return t + 250;
      case 16:
      case 32:
      case 128:
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return t + 5e3;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        return -1;
      case 67108864:
      case 134217728:
      case 268435456:
      case 536870912:
      case 1073741824:
        return -1;
      default:
        return -1;
    }
  }
  function Cf() {
    var l = qu;
    return qu <<= 1, (qu & 62914560) === 0 && (qu = 4194304), l;
  }
  function ci(l) {
    for (var t = [], e = 0; 31 > e; e++) t.push(l);
    return t;
  }
  function Ya(l, t) {
    l.pendingLanes |= t, t !== 268435456 && (l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0);
  }
  function em(l, t, e, a, u, n) {
    var i = l.pendingLanes;
    l.pendingLanes = e, l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0, l.expiredLanes &= e, l.entangledLanes &= e, l.errorRecoveryDisabledLanes &= e, l.shellSuspendCounter = 0;
    var c = l.entanglements, s = l.expirationTimes, y = l.hiddenUpdates;
    for (e = i & ~e; 0 < e; ) {
      var b = 31 - it(e), j = 1 << b;
      c[b] = 0, s[b] = -1;
      var g = y[b];
      if (g !== null)
        for (y[b] = null, b = 0; b < g.length; b++) {
          var S = g[b];
          S !== null && (S.lane &= -536870913);
        }
      e &= ~j;
    }
    a !== 0 && Hf(l, a, 0), n !== 0 && u === 0 && l.tag !== 0 && (l.suspendedLanes |= n & ~(i & ~t));
  }
  function Hf(l, t, e) {
    l.pendingLanes |= t, l.suspendedLanes &= ~t;
    var a = 31 - it(t);
    l.entangledLanes |= t, l.entanglements[a] = l.entanglements[a] | 1073741824 | e & 261930;
  }
  function qf(l, t) {
    var e = l.entangledLanes |= t;
    for (l = l.entanglements; e; ) {
      var a = 31 - it(e), u = 1 << a;
      u & t | l[a] & t && (l[a] |= t), e &= ~u;
    }
  }
  function Bf(l, t) {
    var e = t & -t;
    return e = (e & 42) !== 0 ? 1 : fi(e), (e & (l.suspendedLanes | t)) !== 0 ? 0 : e;
  }
  function fi(l) {
    switch (l) {
      case 2:
        l = 1;
        break;
      case 8:
        l = 4;
        break;
      case 32:
        l = 16;
        break;
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        l = 128;
        break;
      case 268435456:
        l = 134217728;
        break;
      default:
        l = 0;
    }
    return l;
  }
  function si(l) {
    return l &= -l, 2 < l ? 8 < l ? (l & 134217727) !== 0 ? 32 : 268435456 : 8 : 2;
  }
  function Yf() {
    var l = U.p;
    return l !== 0 ? l : (l = window.event, l === void 0 ? 32 : jr(l.type));
  }
  function Gf(l, t) {
    var e = U.p;
    try {
      return U.p = l, t();
    } finally {
      U.p = e;
    }
  }
  var ee = Math.random().toString(36).slice(2), Bl = "__reactFiber$" + ee, Wl = "__reactProps$" + ee, ke = "__reactContainer$" + ee, oi = "__reactEvents$" + ee, am = "__reactListeners$" + ee, um = "__reactHandles$" + ee, Lf = "__reactResources$" + ee, Ga = "__reactMarker$" + ee;
  function di(l) {
    delete l[Bl], delete l[Wl], delete l[oi], delete l[am], delete l[um];
  }
  function Fe(l) {
    var t = l[Bl];
    if (t) return t;
    for (var e = l.parentNode; e; ) {
      if (t = e[ke] || e[Bl]) {
        if (e = t.alternate, t.child !== null || e !== null && e.child !== null)
          for (l = fr(l); l !== null; ) {
            if (e = l[Bl]) return e;
            l = fr(l);
          }
        return t;
      }
      l = e, e = l.parentNode;
    }
    return null;
  }
  function Ie(l) {
    if (l = l[Bl] || l[ke]) {
      var t = l.tag;
      if (t === 5 || t === 6 || t === 13 || t === 31 || t === 26 || t === 27 || t === 3)
        return l;
    }
    return null;
  }
  function La(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l.stateNode;
    throw Error(d(33));
  }
  function Pe(l) {
    var t = l[Lf];
    return t || (t = l[Lf] = { hoistableStyles: /* @__PURE__ */ new Map(), hoistableScripts: /* @__PURE__ */ new Map() }), t;
  }
  function Hl(l) {
    l[Ga] = !0;
  }
  var Xf = /* @__PURE__ */ new Set(), Qf = {};
  function Me(l, t) {
    la(l, t), la(l + "Capture", t);
  }
  function la(l, t) {
    for (Qf[l] = t, l = 0; l < t.length; l++)
      Xf.add(t[l]);
  }
  var nm = RegExp(
    "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"
  ), Zf = {}, Vf = {};
  function im(l) {
    return ui.call(Vf, l) ? !0 : ui.call(Zf, l) ? !1 : nm.test(l) ? Vf[l] = !0 : (Zf[l] = !0, !1);
  }
  function Yu(l, t, e) {
    if (im(t))
      if (e === null) l.removeAttribute(t);
      else {
        switch (typeof e) {
          case "undefined":
          case "function":
          case "symbol":
            l.removeAttribute(t);
            return;
          case "boolean":
            var a = t.toLowerCase().slice(0, 5);
            if (a !== "data-" && a !== "aria-") {
              l.removeAttribute(t);
              return;
            }
        }
        l.setAttribute(t, "" + e);
      }
  }
  function Gu(l, t, e) {
    if (e === null) l.removeAttribute(t);
    else {
      switch (typeof e) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          l.removeAttribute(t);
          return;
      }
      l.setAttribute(t, "" + e);
    }
  }
  function qt(l, t, e, a) {
    if (a === null) l.removeAttribute(e);
    else {
      switch (typeof a) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          l.removeAttribute(e);
          return;
      }
      l.setAttributeNS(t, e, "" + a);
    }
  }
  function vt(l) {
    switch (typeof l) {
      case "bigint":
      case "boolean":
      case "number":
      case "string":
      case "undefined":
        return l;
      case "object":
        return l;
      default:
        return "";
    }
  }
  function Kf(l) {
    var t = l.type;
    return (l = l.nodeName) && l.toLowerCase() === "input" && (t === "checkbox" || t === "radio");
  }
  function cm(l, t, e) {
    var a = Object.getOwnPropertyDescriptor(
      l.constructor.prototype,
      t
    );
    if (!l.hasOwnProperty(t) && typeof a < "u" && typeof a.get == "function" && typeof a.set == "function") {
      var u = a.get, n = a.set;
      return Object.defineProperty(l, t, {
        configurable: !0,
        get: function() {
          return u.call(this);
        },
        set: function(i) {
          e = "" + i, n.call(this, i);
        }
      }), Object.defineProperty(l, t, {
        enumerable: a.enumerable
      }), {
        getValue: function() {
          return e;
        },
        setValue: function(i) {
          e = "" + i;
        },
        stopTracking: function() {
          l._valueTracker = null, delete l[t];
        }
      };
    }
  }
  function ri(l) {
    if (!l._valueTracker) {
      var t = Kf(l) ? "checked" : "value";
      l._valueTracker = cm(
        l,
        t,
        "" + l[t]
      );
    }
  }
  function Jf(l) {
    if (!l) return !1;
    var t = l._valueTracker;
    if (!t) return !0;
    var e = t.getValue(), a = "";
    return l && (a = Kf(l) ? l.checked ? "true" : "false" : l.value), l = a, l !== e ? (t.setValue(l), !0) : !1;
  }
  function Lu(l) {
    if (l = l || (typeof document < "u" ? document : void 0), typeof l > "u") return null;
    try {
      return l.activeElement || l.body;
    } catch {
      return l.body;
    }
  }
  var fm = /[\n"\\]/g;
  function yt(l) {
    return l.replace(
      fm,
      function(t) {
        return "\\" + t.charCodeAt(0).toString(16) + " ";
      }
    );
  }
  function mi(l, t, e, a, u, n, i, c) {
    l.name = "", i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" ? l.type = i : l.removeAttribute("type"), t != null ? i === "number" ? (t === 0 && l.value === "" || l.value != t) && (l.value = "" + vt(t)) : l.value !== "" + vt(t) && (l.value = "" + vt(t)) : i !== "submit" && i !== "reset" || l.removeAttribute("value"), t != null ? hi(l, i, vt(t)) : e != null ? hi(l, i, vt(e)) : a != null && l.removeAttribute("value"), u == null && n != null && (l.defaultChecked = !!n), u != null && (l.checked = u && typeof u != "function" && typeof u != "symbol"), c != null && typeof c != "function" && typeof c != "symbol" && typeof c != "boolean" ? l.name = "" + vt(c) : l.removeAttribute("name");
  }
  function wf(l, t, e, a, u, n, i, c) {
    if (n != null && typeof n != "function" && typeof n != "symbol" && typeof n != "boolean" && (l.type = n), t != null || e != null) {
      if (!(n !== "submit" && n !== "reset" || t != null)) {
        ri(l);
        return;
      }
      e = e != null ? "" + vt(e) : "", t = t != null ? "" + vt(t) : e, c || t === l.value || (l.value = t), l.defaultValue = t;
    }
    a = a ?? u, a = typeof a != "function" && typeof a != "symbol" && !!a, l.checked = c ? l.checked : !!a, l.defaultChecked = !!a, i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" && (l.name = i), ri(l);
  }
  function hi(l, t, e) {
    t === "number" && Lu(l.ownerDocument) === l || l.defaultValue === "" + e || (l.defaultValue = "" + e);
  }
  function ta(l, t, e, a) {
    if (l = l.options, t) {
      t = {};
      for (var u = 0; u < e.length; u++)
        t["$" + e[u]] = !0;
      for (e = 0; e < l.length; e++)
        u = t.hasOwnProperty("$" + l[e].value), l[e].selected !== u && (l[e].selected = u), u && a && (l[e].defaultSelected = !0);
    } else {
      for (e = "" + vt(e), t = null, u = 0; u < l.length; u++) {
        if (l[u].value === e) {
          l[u].selected = !0, a && (l[u].defaultSelected = !0);
          return;
        }
        t !== null || l[u].disabled || (t = l[u]);
      }
      t !== null && (t.selected = !0);
    }
  }
  function $f(l, t, e) {
    if (t != null && (t = "" + vt(t), t !== l.value && (l.value = t), e == null)) {
      l.defaultValue !== t && (l.defaultValue = t);
      return;
    }
    l.defaultValue = e != null ? "" + vt(e) : "";
  }
  function Wf(l, t, e, a) {
    if (t == null) {
      if (a != null) {
        if (e != null) throw Error(d(92));
        if (Et(a)) {
          if (1 < a.length) throw Error(d(93));
          a = a[0];
        }
        e = a;
      }
      e == null && (e = ""), t = e;
    }
    e = vt(t), l.defaultValue = e, a = l.textContent, a === e && a !== "" && a !== null && (l.value = a), ri(l);
  }
  function ea(l, t) {
    if (t) {
      var e = l.firstChild;
      if (e && e === l.lastChild && e.nodeType === 3) {
        e.nodeValue = t;
        return;
      }
    }
    l.textContent = t;
  }
  var sm = new Set(
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
      " "
    )
  );
  function kf(l, t, e) {
    var a = t.indexOf("--") === 0;
    e == null || typeof e == "boolean" || e === "" ? a ? l.setProperty(t, "") : t === "float" ? l.cssFloat = "" : l[t] = "" : a ? l.setProperty(t, e) : typeof e != "number" || e === 0 || sm.has(t) ? t === "float" ? l.cssFloat = e : l[t] = ("" + e).trim() : l[t] = e + "px";
  }
  function Ff(l, t, e) {
    if (t != null && typeof t != "object")
      throw Error(d(62));
    if (l = l.style, e != null) {
      for (var a in e)
        !e.hasOwnProperty(a) || t != null && t.hasOwnProperty(a) || (a.indexOf("--") === 0 ? l.setProperty(a, "") : a === "float" ? l.cssFloat = "" : l[a] = "");
      for (var u in t)
        a = t[u], t.hasOwnProperty(u) && e[u] !== a && kf(l, u, a);
    } else
      for (var n in t)
        t.hasOwnProperty(n) && kf(l, n, t[n]);
  }
  function vi(l) {
    if (l.indexOf("-") === -1) return !1;
    switch (l) {
      case "annotation-xml":
      case "color-profile":
      case "font-face":
      case "font-face-src":
      case "font-face-uri":
      case "font-face-format":
      case "font-face-name":
      case "missing-glyph":
        return !1;
      default:
        return !0;
    }
  }
  var om = /* @__PURE__ */ new Map([
    ["acceptCharset", "accept-charset"],
    ["htmlFor", "for"],
    ["httpEquiv", "http-equiv"],
    ["crossOrigin", "crossorigin"],
    ["accentHeight", "accent-height"],
    ["alignmentBaseline", "alignment-baseline"],
    ["arabicForm", "arabic-form"],
    ["baselineShift", "baseline-shift"],
    ["capHeight", "cap-height"],
    ["clipPath", "clip-path"],
    ["clipRule", "clip-rule"],
    ["colorInterpolation", "color-interpolation"],
    ["colorInterpolationFilters", "color-interpolation-filters"],
    ["colorProfile", "color-profile"],
    ["colorRendering", "color-rendering"],
    ["dominantBaseline", "dominant-baseline"],
    ["enableBackground", "enable-background"],
    ["fillOpacity", "fill-opacity"],
    ["fillRule", "fill-rule"],
    ["floodColor", "flood-color"],
    ["floodOpacity", "flood-opacity"],
    ["fontFamily", "font-family"],
    ["fontSize", "font-size"],
    ["fontSizeAdjust", "font-size-adjust"],
    ["fontStretch", "font-stretch"],
    ["fontStyle", "font-style"],
    ["fontVariant", "font-variant"],
    ["fontWeight", "font-weight"],
    ["glyphName", "glyph-name"],
    ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
    ["glyphOrientationVertical", "glyph-orientation-vertical"],
    ["horizAdvX", "horiz-adv-x"],
    ["horizOriginX", "horiz-origin-x"],
    ["imageRendering", "image-rendering"],
    ["letterSpacing", "letter-spacing"],
    ["lightingColor", "lighting-color"],
    ["markerEnd", "marker-end"],
    ["markerMid", "marker-mid"],
    ["markerStart", "marker-start"],
    ["overlinePosition", "overline-position"],
    ["overlineThickness", "overline-thickness"],
    ["paintOrder", "paint-order"],
    ["panose-1", "panose-1"],
    ["pointerEvents", "pointer-events"],
    ["renderingIntent", "rendering-intent"],
    ["shapeRendering", "shape-rendering"],
    ["stopColor", "stop-color"],
    ["stopOpacity", "stop-opacity"],
    ["strikethroughPosition", "strikethrough-position"],
    ["strikethroughThickness", "strikethrough-thickness"],
    ["strokeDasharray", "stroke-dasharray"],
    ["strokeDashoffset", "stroke-dashoffset"],
    ["strokeLinecap", "stroke-linecap"],
    ["strokeLinejoin", "stroke-linejoin"],
    ["strokeMiterlimit", "stroke-miterlimit"],
    ["strokeOpacity", "stroke-opacity"],
    ["strokeWidth", "stroke-width"],
    ["textAnchor", "text-anchor"],
    ["textDecoration", "text-decoration"],
    ["textRendering", "text-rendering"],
    ["transformOrigin", "transform-origin"],
    ["underlinePosition", "underline-position"],
    ["underlineThickness", "underline-thickness"],
    ["unicodeBidi", "unicode-bidi"],
    ["unicodeRange", "unicode-range"],
    ["unitsPerEm", "units-per-em"],
    ["vAlphabetic", "v-alphabetic"],
    ["vHanging", "v-hanging"],
    ["vIdeographic", "v-ideographic"],
    ["vMathematical", "v-mathematical"],
    ["vectorEffect", "vector-effect"],
    ["vertAdvY", "vert-adv-y"],
    ["vertOriginX", "vert-origin-x"],
    ["vertOriginY", "vert-origin-y"],
    ["wordSpacing", "word-spacing"],
    ["writingMode", "writing-mode"],
    ["xmlnsXlink", "xmlns:xlink"],
    ["xHeight", "x-height"]
  ]), dm = /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function Xu(l) {
    return dm.test("" + l) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : l;
  }
  function Bt() {
  }
  var yi = null;
  function gi(l) {
    return l = l.target || l.srcElement || window, l.correspondingUseElement && (l = l.correspondingUseElement), l.nodeType === 3 ? l.parentNode : l;
  }
  var aa = null, ua = null;
  function If(l) {
    var t = Ie(l);
    if (t && (l = t.stateNode)) {
      var e = l[Wl] || null;
      l: switch (l = t.stateNode, t.type) {
        case "input":
          if (mi(
            l,
            e.value,
            e.defaultValue,
            e.defaultValue,
            e.checked,
            e.defaultChecked,
            e.type,
            e.name
          ), t = e.name, e.type === "radio" && t != null) {
            for (e = l; e.parentNode; ) e = e.parentNode;
            for (e = e.querySelectorAll(
              'input[name="' + yt(
                "" + t
              ) + '"][type="radio"]'
            ), t = 0; t < e.length; t++) {
              var a = e[t];
              if (a !== l && a.form === l.form) {
                var u = a[Wl] || null;
                if (!u) throw Error(d(90));
                mi(
                  a,
                  u.value,
                  u.defaultValue,
                  u.defaultValue,
                  u.checked,
                  u.defaultChecked,
                  u.type,
                  u.name
                );
              }
            }
            for (t = 0; t < e.length; t++)
              a = e[t], a.form === l.form && Jf(a);
          }
          break l;
        case "textarea":
          $f(l, e.value, e.defaultValue);
          break l;
        case "select":
          t = e.value, t != null && ta(l, !!e.multiple, t, !1);
      }
    }
  }
  var Si = !1;
  function Pf(l, t, e) {
    if (Si) return l(t, e);
    Si = !0;
    try {
      var a = l(t);
      return a;
    } finally {
      if (Si = !1, (aa !== null || ua !== null) && (_n(), aa && (t = aa, l = ua, ua = aa = null, If(t), l)))
        for (t = 0; t < l.length; t++) If(l[t]);
    }
  }
  function Xa(l, t) {
    var e = l.stateNode;
    if (e === null) return null;
    var a = e[Wl] || null;
    if (a === null) return null;
    e = a[t];
    l: switch (t) {
      case "onClick":
      case "onClickCapture":
      case "onDoubleClick":
      case "onDoubleClickCapture":
      case "onMouseDown":
      case "onMouseDownCapture":
      case "onMouseMove":
      case "onMouseMoveCapture":
      case "onMouseUp":
      case "onMouseUpCapture":
      case "onMouseEnter":
        (a = !a.disabled) || (l = l.type, a = !(l === "button" || l === "input" || l === "select" || l === "textarea")), l = !a;
        break l;
      default:
        l = !1;
    }
    if (l) return null;
    if (e && typeof e != "function")
      throw Error(
        d(231, t, typeof e)
      );
    return e;
  }
  var Yt = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), bi = !1;
  if (Yt)
    try {
      var Qa = {};
      Object.defineProperty(Qa, "passive", {
        get: function() {
          bi = !0;
        }
      }), window.addEventListener("test", Qa, Qa), window.removeEventListener("test", Qa, Qa);
    } catch {
      bi = !1;
    }
  var ae = null, pi = null, Qu = null;
  function ls() {
    if (Qu) return Qu;
    var l, t = pi, e = t.length, a, u = "value" in ae ? ae.value : ae.textContent, n = u.length;
    for (l = 0; l < e && t[l] === u[l]; l++) ;
    var i = e - l;
    for (a = 1; a <= i && t[e - a] === u[n - a]; a++) ;
    return Qu = u.slice(l, 1 < a ? 1 - a : void 0);
  }
  function Zu(l) {
    var t = l.keyCode;
    return "charCode" in l ? (l = l.charCode, l === 0 && t === 13 && (l = 13)) : l = t, l === 10 && (l = 13), 32 <= l || l === 13 ? l : 0;
  }
  function Vu() {
    return !0;
  }
  function ts() {
    return !1;
  }
  function kl(l) {
    function t(e, a, u, n, i) {
      this._reactName = e, this._targetInst = u, this.type = a, this.nativeEvent = n, this.target = i, this.currentTarget = null;
      for (var c in l)
        l.hasOwnProperty(c) && (e = l[c], this[c] = e ? e(n) : n[c]);
      return this.isDefaultPrevented = (n.defaultPrevented != null ? n.defaultPrevented : n.returnValue === !1) ? Vu : ts, this.isPropagationStopped = ts, this;
    }
    return p(t.prototype, {
      preventDefault: function() {
        this.defaultPrevented = !0;
        var e = this.nativeEvent;
        e && (e.preventDefault ? e.preventDefault() : typeof e.returnValue != "unknown" && (e.returnValue = !1), this.isDefaultPrevented = Vu);
      },
      stopPropagation: function() {
        var e = this.nativeEvent;
        e && (e.stopPropagation ? e.stopPropagation() : typeof e.cancelBubble != "unknown" && (e.cancelBubble = !0), this.isPropagationStopped = Vu);
      },
      persist: function() {
      },
      isPersistent: Vu
    }), t;
  }
  var De = {
    eventPhase: 0,
    bubbles: 0,
    cancelable: 0,
    timeStamp: function(l) {
      return l.timeStamp || Date.now();
    },
    defaultPrevented: 0,
    isTrusted: 0
  }, Ku = kl(De), Za = p({}, De, { view: 0, detail: 0 }), rm = kl(Za), Ai, zi, Va, Ju = p({}, Za, {
    screenX: 0,
    screenY: 0,
    clientX: 0,
    clientY: 0,
    pageX: 0,
    pageY: 0,
    ctrlKey: 0,
    shiftKey: 0,
    altKey: 0,
    metaKey: 0,
    getModifierState: ji,
    button: 0,
    buttons: 0,
    relatedTarget: function(l) {
      return l.relatedTarget === void 0 ? l.fromElement === l.srcElement ? l.toElement : l.fromElement : l.relatedTarget;
    },
    movementX: function(l) {
      return "movementX" in l ? l.movementX : (l !== Va && (Va && l.type === "mousemove" ? (Ai = l.screenX - Va.screenX, zi = l.screenY - Va.screenY) : zi = Ai = 0, Va = l), Ai);
    },
    movementY: function(l) {
      return "movementY" in l ? l.movementY : zi;
    }
  }), es = kl(Ju), mm = p({}, Ju, { dataTransfer: 0 }), hm = kl(mm), vm = p({}, Za, { relatedTarget: 0 }), Ti = kl(vm), ym = p({}, De, {
    animationName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), gm = kl(ym), Sm = p({}, De, {
    clipboardData: function(l) {
      return "clipboardData" in l ? l.clipboardData : window.clipboardData;
    }
  }), bm = kl(Sm), pm = p({}, De, { data: 0 }), as = kl(pm), Am = {
    Esc: "Escape",
    Spacebar: " ",
    Left: "ArrowLeft",
    Up: "ArrowUp",
    Right: "ArrowRight",
    Down: "ArrowDown",
    Del: "Delete",
    Win: "OS",
    Menu: "ContextMenu",
    Apps: "ContextMenu",
    Scroll: "ScrollLock",
    MozPrintableKey: "Unidentified"
  }, zm = {
    8: "Backspace",
    9: "Tab",
    12: "Clear",
    13: "Enter",
    16: "Shift",
    17: "Control",
    18: "Alt",
    19: "Pause",
    20: "CapsLock",
    27: "Escape",
    32: " ",
    33: "PageUp",
    34: "PageDown",
    35: "End",
    36: "Home",
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    45: "Insert",
    46: "Delete",
    112: "F1",
    113: "F2",
    114: "F3",
    115: "F4",
    116: "F5",
    117: "F6",
    118: "F7",
    119: "F8",
    120: "F9",
    121: "F10",
    122: "F11",
    123: "F12",
    144: "NumLock",
    145: "ScrollLock",
    224: "Meta"
  }, Tm = {
    Alt: "altKey",
    Control: "ctrlKey",
    Meta: "metaKey",
    Shift: "shiftKey"
  };
  function jm(l) {
    var t = this.nativeEvent;
    return t.getModifierState ? t.getModifierState(l) : (l = Tm[l]) ? !!t[l] : !1;
  }
  function ji() {
    return jm;
  }
  var Em = p({}, Za, {
    key: function(l) {
      if (l.key) {
        var t = Am[l.key] || l.key;
        if (t !== "Unidentified") return t;
      }
      return l.type === "keypress" ? (l = Zu(l), l === 13 ? "Enter" : String.fromCharCode(l)) : l.type === "keydown" || l.type === "keyup" ? zm[l.keyCode] || "Unidentified" : "";
    },
    code: 0,
    location: 0,
    ctrlKey: 0,
    shiftKey: 0,
    altKey: 0,
    metaKey: 0,
    repeat: 0,
    locale: 0,
    getModifierState: ji,
    charCode: function(l) {
      return l.type === "keypress" ? Zu(l) : 0;
    },
    keyCode: function(l) {
      return l.type === "keydown" || l.type === "keyup" ? l.keyCode : 0;
    },
    which: function(l) {
      return l.type === "keypress" ? Zu(l) : l.type === "keydown" || l.type === "keyup" ? l.keyCode : 0;
    }
  }), xm = kl(Em), Nm = p({}, Ju, {
    pointerId: 0,
    width: 0,
    height: 0,
    pressure: 0,
    tangentialPressure: 0,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    pointerType: 0,
    isPrimary: 0
  }), us = kl(Nm), Om = p({}, Za, {
    touches: 0,
    targetTouches: 0,
    changedTouches: 0,
    altKey: 0,
    metaKey: 0,
    ctrlKey: 0,
    shiftKey: 0,
    getModifierState: ji
  }), _m = kl(Om), Mm = p({}, De, {
    propertyName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Dm = kl(Mm), Um = p({}, Ju, {
    deltaX: function(l) {
      return "deltaX" in l ? l.deltaX : "wheelDeltaX" in l ? -l.wheelDeltaX : 0;
    },
    deltaY: function(l) {
      return "deltaY" in l ? l.deltaY : "wheelDeltaY" in l ? -l.wheelDeltaY : "wheelDelta" in l ? -l.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), Rm = kl(Um), Cm = p({}, De, {
    newState: 0,
    oldState: 0
  }), Hm = kl(Cm), qm = [9, 13, 27, 32], Ei = Yt && "CompositionEvent" in window, Ka = null;
  Yt && "documentMode" in document && (Ka = document.documentMode);
  var Bm = Yt && "TextEvent" in window && !Ka, ns = Yt && (!Ei || Ka && 8 < Ka && 11 >= Ka), is = " ", cs = !1;
  function fs(l, t) {
    switch (l) {
      case "keyup":
        return qm.indexOf(t.keyCode) !== -1;
      case "keydown":
        return t.keyCode !== 229;
      case "keypress":
      case "mousedown":
      case "focusout":
        return !0;
      default:
        return !1;
    }
  }
  function ss(l) {
    return l = l.detail, typeof l == "object" && "data" in l ? l.data : null;
  }
  var na = !1;
  function Ym(l, t) {
    switch (l) {
      case "compositionend":
        return ss(t);
      case "keypress":
        return t.which !== 32 ? null : (cs = !0, is);
      case "textInput":
        return l = t.data, l === is && cs ? null : l;
      default:
        return null;
    }
  }
  function Gm(l, t) {
    if (na)
      return l === "compositionend" || !Ei && fs(l, t) ? (l = ls(), Qu = pi = ae = null, na = !1, l) : null;
    switch (l) {
      case "paste":
        return null;
      case "keypress":
        if (!(t.ctrlKey || t.altKey || t.metaKey) || t.ctrlKey && t.altKey) {
          if (t.char && 1 < t.char.length)
            return t.char;
          if (t.which) return String.fromCharCode(t.which);
        }
        return null;
      case "compositionend":
        return ns && t.locale !== "ko" ? null : t.data;
      default:
        return null;
    }
  }
  var Lm = {
    color: !0,
    date: !0,
    datetime: !0,
    "datetime-local": !0,
    email: !0,
    month: !0,
    number: !0,
    password: !0,
    range: !0,
    search: !0,
    tel: !0,
    text: !0,
    time: !0,
    url: !0,
    week: !0
  };
  function os(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t === "input" ? !!Lm[l.type] : t === "textarea";
  }
  function ds(l, t, e, a) {
    aa ? ua ? ua.push(a) : ua = [a] : aa = a, t = qn(t, "onChange"), 0 < t.length && (e = new Ku(
      "onChange",
      "change",
      null,
      e,
      a
    ), l.push({ event: e, listeners: t }));
  }
  var Ja = null, wa = null;
  function Xm(l) {
    $d(l, 0);
  }
  function wu(l) {
    var t = La(l);
    if (Jf(t)) return l;
  }
  function rs(l, t) {
    if (l === "change") return t;
  }
  var ms = !1;
  if (Yt) {
    var xi;
    if (Yt) {
      var Ni = "oninput" in document;
      if (!Ni) {
        var hs = document.createElement("div");
        hs.setAttribute("oninput", "return;"), Ni = typeof hs.oninput == "function";
      }
      xi = Ni;
    } else xi = !1;
    ms = xi && (!document.documentMode || 9 < document.documentMode);
  }
  function vs() {
    Ja && (Ja.detachEvent("onpropertychange", ys), wa = Ja = null);
  }
  function ys(l) {
    if (l.propertyName === "value" && wu(wa)) {
      var t = [];
      ds(
        t,
        wa,
        l,
        gi(l)
      ), Pf(Xm, t);
    }
  }
  function Qm(l, t, e) {
    l === "focusin" ? (vs(), Ja = t, wa = e, Ja.attachEvent("onpropertychange", ys)) : l === "focusout" && vs();
  }
  function Zm(l) {
    if (l === "selectionchange" || l === "keyup" || l === "keydown")
      return wu(wa);
  }
  function Vm(l, t) {
    if (l === "click") return wu(t);
  }
  function Km(l, t) {
    if (l === "input" || l === "change")
      return wu(t);
  }
  function Jm(l, t) {
    return l === t && (l !== 0 || 1 / l === 1 / t) || l !== l && t !== t;
  }
  var ct = typeof Object.is == "function" ? Object.is : Jm;
  function $a(l, t) {
    if (ct(l, t)) return !0;
    if (typeof l != "object" || l === null || typeof t != "object" || t === null)
      return !1;
    var e = Object.keys(l), a = Object.keys(t);
    if (e.length !== a.length) return !1;
    for (a = 0; a < e.length; a++) {
      var u = e[a];
      if (!ui.call(t, u) || !ct(l[u], t[u]))
        return !1;
    }
    return !0;
  }
  function gs(l) {
    for (; l && l.firstChild; ) l = l.firstChild;
    return l;
  }
  function Ss(l, t) {
    var e = gs(l);
    l = 0;
    for (var a; e; ) {
      if (e.nodeType === 3) {
        if (a = l + e.textContent.length, l <= t && a >= t)
          return { node: e, offset: t - l };
        l = a;
      }
      l: {
        for (; e; ) {
          if (e.nextSibling) {
            e = e.nextSibling;
            break l;
          }
          e = e.parentNode;
        }
        e = void 0;
      }
      e = gs(e);
    }
  }
  function bs(l, t) {
    return l && t ? l === t ? !0 : l && l.nodeType === 3 ? !1 : t && t.nodeType === 3 ? bs(l, t.parentNode) : "contains" in l ? l.contains(t) : l.compareDocumentPosition ? !!(l.compareDocumentPosition(t) & 16) : !1 : !1;
  }
  function ps(l) {
    l = l != null && l.ownerDocument != null && l.ownerDocument.defaultView != null ? l.ownerDocument.defaultView : window;
    for (var t = Lu(l.document); t instanceof l.HTMLIFrameElement; ) {
      try {
        var e = typeof t.contentWindow.location.href == "string";
      } catch {
        e = !1;
      }
      if (e) l = t.contentWindow;
      else break;
      t = Lu(l.document);
    }
    return t;
  }
  function Oi(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t && (t === "input" && (l.type === "text" || l.type === "search" || l.type === "tel" || l.type === "url" || l.type === "password") || t === "textarea" || l.contentEditable === "true");
  }
  var wm = Yt && "documentMode" in document && 11 >= document.documentMode, ia = null, _i = null, Wa = null, Mi = !1;
  function As(l, t, e) {
    var a = e.window === e ? e.document : e.nodeType === 9 ? e : e.ownerDocument;
    Mi || ia == null || ia !== Lu(a) || (a = ia, "selectionStart" in a && Oi(a) ? a = { start: a.selectionStart, end: a.selectionEnd } : (a = (a.ownerDocument && a.ownerDocument.defaultView || window).getSelection(), a = {
      anchorNode: a.anchorNode,
      anchorOffset: a.anchorOffset,
      focusNode: a.focusNode,
      focusOffset: a.focusOffset
    }), Wa && $a(Wa, a) || (Wa = a, a = qn(_i, "onSelect"), 0 < a.length && (t = new Ku(
      "onSelect",
      "select",
      null,
      t,
      e
    ), l.push({ event: t, listeners: a }), t.target = ia)));
  }
  function Ue(l, t) {
    var e = {};
    return e[l.toLowerCase()] = t.toLowerCase(), e["Webkit" + l] = "webkit" + t, e["Moz" + l] = "moz" + t, e;
  }
  var ca = {
    animationend: Ue("Animation", "AnimationEnd"),
    animationiteration: Ue("Animation", "AnimationIteration"),
    animationstart: Ue("Animation", "AnimationStart"),
    transitionrun: Ue("Transition", "TransitionRun"),
    transitionstart: Ue("Transition", "TransitionStart"),
    transitioncancel: Ue("Transition", "TransitionCancel"),
    transitionend: Ue("Transition", "TransitionEnd")
  }, Di = {}, zs = {};
  Yt && (zs = document.createElement("div").style, "AnimationEvent" in window || (delete ca.animationend.animation, delete ca.animationiteration.animation, delete ca.animationstart.animation), "TransitionEvent" in window || delete ca.transitionend.transition);
  function Re(l) {
    if (Di[l]) return Di[l];
    if (!ca[l]) return l;
    var t = ca[l], e;
    for (e in t)
      if (t.hasOwnProperty(e) && e in zs)
        return Di[l] = t[e];
    return l;
  }
  var Ts = Re("animationend"), js = Re("animationiteration"), Es = Re("animationstart"), $m = Re("transitionrun"), Wm = Re("transitionstart"), km = Re("transitioncancel"), xs = Re("transitionend"), Ns = /* @__PURE__ */ new Map(), Ui = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
    " "
  );
  Ui.push("scrollEnd");
  function xt(l, t) {
    Ns.set(l, t), Me(t, [l]);
  }
  var $u = typeof reportError == "function" ? reportError : function(l) {
    if (typeof window == "object" && typeof window.ErrorEvent == "function") {
      var t = new window.ErrorEvent("error", {
        bubbles: !0,
        cancelable: !0,
        message: typeof l == "object" && l !== null && typeof l.message == "string" ? String(l.message) : String(l),
        error: l
      });
      if (!window.dispatchEvent(t)) return;
    } else if (typeof process == "object" && typeof process.emit == "function") {
      process.emit("uncaughtException", l);
      return;
    }
    console.error(l);
  }, gt = [], fa = 0, Ri = 0;
  function Wu() {
    for (var l = fa, t = Ri = fa = 0; t < l; ) {
      var e = gt[t];
      gt[t++] = null;
      var a = gt[t];
      gt[t++] = null;
      var u = gt[t];
      gt[t++] = null;
      var n = gt[t];
      if (gt[t++] = null, a !== null && u !== null) {
        var i = a.pending;
        i === null ? u.next = u : (u.next = i.next, i.next = u), a.pending = u;
      }
      n !== 0 && Os(e, u, n);
    }
  }
  function ku(l, t, e, a) {
    gt[fa++] = l, gt[fa++] = t, gt[fa++] = e, gt[fa++] = a, Ri |= a, l.lanes |= a, l = l.alternate, l !== null && (l.lanes |= a);
  }
  function Ci(l, t, e, a) {
    return ku(l, t, e, a), Fu(l);
  }
  function Ce(l, t) {
    return ku(l, null, null, t), Fu(l);
  }
  function Os(l, t, e) {
    l.lanes |= e;
    var a = l.alternate;
    a !== null && (a.lanes |= e);
    for (var u = !1, n = l.return; n !== null; )
      n.childLanes |= e, a = n.alternate, a !== null && (a.childLanes |= e), n.tag === 22 && (l = n.stateNode, l === null || l._visibility & 1 || (u = !0)), l = n, n = n.return;
    return l.tag === 3 ? (n = l.stateNode, u && t !== null && (u = 31 - it(e), l = n.hiddenUpdates, a = l[u], a === null ? l[u] = [t] : a.push(t), t.lane = e | 536870912), n) : null;
  }
  function Fu(l) {
    if (50 < gu)
      throw gu = 0, Zc = null, Error(d(185));
    for (var t = l.return; t !== null; )
      l = t, t = l.return;
    return l.tag === 3 ? l.stateNode : null;
  }
  var sa = {};
  function Fm(l, t, e, a) {
    this.tag = l, this.key = e, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = a, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function ft(l, t, e, a) {
    return new Fm(l, t, e, a);
  }
  function Hi(l) {
    return l = l.prototype, !(!l || !l.isReactComponent);
  }
  function Gt(l, t) {
    var e = l.alternate;
    return e === null ? (e = ft(
      l.tag,
      t,
      l.key,
      l.mode
    ), e.elementType = l.elementType, e.type = l.type, e.stateNode = l.stateNode, e.alternate = l, l.alternate = e) : (e.pendingProps = t, e.type = l.type, e.flags = 0, e.subtreeFlags = 0, e.deletions = null), e.flags = l.flags & 65011712, e.childLanes = l.childLanes, e.lanes = l.lanes, e.child = l.child, e.memoizedProps = l.memoizedProps, e.memoizedState = l.memoizedState, e.updateQueue = l.updateQueue, t = l.dependencies, e.dependencies = t === null ? null : { lanes: t.lanes, firstContext: t.firstContext }, e.sibling = l.sibling, e.index = l.index, e.ref = l.ref, e.refCleanup = l.refCleanup, e;
  }
  function _s(l, t) {
    l.flags &= 65011714;
    var e = l.alternate;
    return e === null ? (l.childLanes = 0, l.lanes = t, l.child = null, l.subtreeFlags = 0, l.memoizedProps = null, l.memoizedState = null, l.updateQueue = null, l.dependencies = null, l.stateNode = null) : (l.childLanes = e.childLanes, l.lanes = e.lanes, l.child = e.child, l.subtreeFlags = 0, l.deletions = null, l.memoizedProps = e.memoizedProps, l.memoizedState = e.memoizedState, l.updateQueue = e.updateQueue, l.type = e.type, t = e.dependencies, l.dependencies = t === null ? null : {
      lanes: t.lanes,
      firstContext: t.firstContext
    }), l;
  }
  function Iu(l, t, e, a, u, n) {
    var i = 0;
    if (a = l, typeof l == "function") Hi(l) && (i = 1);
    else if (typeof l == "string")
      i = ev(
        l,
        e,
        q.current
      ) ? 26 : l === "html" || l === "head" || l === "body" ? 27 : 5;
    else
      l: switch (l) {
        case wl:
          return l = ft(31, e, t, u), l.elementType = wl, l.lanes = n, l;
        case xl:
          return He(e.children, u, n, t);
        case Nl:
          i = 8, u |= 24;
          break;
        case cl:
          return l = ft(12, e, t, u | 2), l.elementType = cl, l.lanes = n, l;
        case ht:
          return l = ft(13, e, t, u), l.elementType = ht, l.lanes = n, l;
        case Q:
          return l = ft(19, e, t, u), l.elementType = Q, l.lanes = n, l;
        default:
          if (typeof l == "object" && l !== null)
            switch (l.$$typeof) {
              case Rl:
                i = 10;
                break l;
              case tl:
                i = 9;
                break l;
              case Jl:
                i = 11;
                break l;
              case $:
                i = 14;
                break l;
              case Cl:
                i = 16, a = null;
                break l;
            }
          i = 29, e = Error(
            d(130, l === null ? "null" : typeof l, "")
          ), a = null;
      }
    return t = ft(i, e, t, u), t.elementType = l, t.type = a, t.lanes = n, t;
  }
  function He(l, t, e, a) {
    return l = ft(7, l, a, t), l.lanes = e, l;
  }
  function qi(l, t, e) {
    return l = ft(6, l, null, t), l.lanes = e, l;
  }
  function Ms(l) {
    var t = ft(18, null, null, 0);
    return t.stateNode = l, t;
  }
  function Bi(l, t, e) {
    return t = ft(
      4,
      l.children !== null ? l.children : [],
      l.key,
      t
    ), t.lanes = e, t.stateNode = {
      containerInfo: l.containerInfo,
      pendingChildren: null,
      implementation: l.implementation
    }, t;
  }
  var Ds = /* @__PURE__ */ new WeakMap();
  function St(l, t) {
    if (typeof l == "object" && l !== null) {
      var e = Ds.get(l);
      return e !== void 0 ? e : (t = {
        value: l,
        source: t,
        stack: Mf(t)
      }, Ds.set(l, t), t);
    }
    return {
      value: l,
      source: t,
      stack: Mf(t)
    };
  }
  var oa = [], da = 0, Pu = null, ka = 0, bt = [], pt = 0, ue = null, Dt = 1, Ut = "";
  function Lt(l, t) {
    oa[da++] = ka, oa[da++] = Pu, Pu = l, ka = t;
  }
  function Us(l, t, e) {
    bt[pt++] = Dt, bt[pt++] = Ut, bt[pt++] = ue, ue = l;
    var a = Dt;
    l = Ut;
    var u = 32 - it(a) - 1;
    a &= ~(1 << u), e += 1;
    var n = 32 - it(t) + u;
    if (30 < n) {
      var i = u - u % 5;
      n = (a & (1 << i) - 1).toString(32), a >>= i, u -= i, Dt = 1 << 32 - it(t) + u | e << u | a, Ut = n + l;
    } else
      Dt = 1 << n | e << u | a, Ut = l;
  }
  function Yi(l) {
    l.return !== null && (Lt(l, 1), Us(l, 1, 0));
  }
  function Gi(l) {
    for (; l === Pu; )
      Pu = oa[--da], oa[da] = null, ka = oa[--da], oa[da] = null;
    for (; l === ue; )
      ue = bt[--pt], bt[pt] = null, Ut = bt[--pt], bt[pt] = null, Dt = bt[--pt], bt[pt] = null;
  }
  function Rs(l, t) {
    bt[pt++] = Dt, bt[pt++] = Ut, bt[pt++] = ue, Dt = t.id, Ut = t.overflow, ue = l;
  }
  var Yl = null, yl = null, el = !1, ne = null, At = !1, Li = Error(d(519));
  function ie(l) {
    var t = Error(
      d(
        418,
        1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML",
        ""
      )
    );
    throw Fa(St(t, l)), Li;
  }
  function Cs(l) {
    var t = l.stateNode, e = l.type, a = l.memoizedProps;
    switch (t[Bl] = l, t[Wl] = a, e) {
      case "dialog":
        I("cancel", t), I("close", t);
        break;
      case "iframe":
      case "object":
      case "embed":
        I("load", t);
        break;
      case "video":
      case "audio":
        for (e = 0; e < bu.length; e++)
          I(bu[e], t);
        break;
      case "source":
        I("error", t);
        break;
      case "img":
      case "image":
      case "link":
        I("error", t), I("load", t);
        break;
      case "details":
        I("toggle", t);
        break;
      case "input":
        I("invalid", t), wf(
          t,
          a.value,
          a.defaultValue,
          a.checked,
          a.defaultChecked,
          a.type,
          a.name,
          !0
        );
        break;
      case "select":
        I("invalid", t);
        break;
      case "textarea":
        I("invalid", t), Wf(t, a.value, a.defaultValue, a.children);
    }
    e = a.children, typeof e != "string" && typeof e != "number" && typeof e != "bigint" || t.textContent === "" + e || a.suppressHydrationWarning === !0 || Id(t.textContent, e) ? (a.popover != null && (I("beforetoggle", t), I("toggle", t)), a.onScroll != null && I("scroll", t), a.onScrollEnd != null && I("scrollend", t), a.onClick != null && (t.onclick = Bt), t = !0) : t = !1, t || ie(l, !0);
  }
  function Hs(l) {
    for (Yl = l.return; Yl; )
      switch (Yl.tag) {
        case 5:
        case 31:
        case 13:
          At = !1;
          return;
        case 27:
        case 3:
          At = !0;
          return;
        default:
          Yl = Yl.return;
      }
  }
  function ra(l) {
    if (l !== Yl) return !1;
    if (!el) return Hs(l), el = !0, !1;
    var t = l.tag, e;
    if ((e = t !== 3 && t !== 27) && ((e = t === 5) && (e = l.type, e = !(e !== "form" && e !== "button") || uf(l.type, l.memoizedProps)), e = !e), e && yl && ie(l), Hs(l), t === 13) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(d(317));
      yl = cr(l);
    } else if (t === 31) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(d(317));
      yl = cr(l);
    } else
      t === 27 ? (t = yl, pe(l.type) ? (l = of, of = null, yl = l) : yl = t) : yl = Yl ? Tt(l.stateNode.nextSibling) : null;
    return !0;
  }
  function qe() {
    yl = Yl = null, el = !1;
  }
  function Xi() {
    var l = ne;
    return l !== null && (lt === null ? lt = l : lt.push.apply(
      lt,
      l
    ), ne = null), l;
  }
  function Fa(l) {
    ne === null ? ne = [l] : ne.push(l);
  }
  var Qi = r(null), Be = null, Xt = null;
  function ce(l, t, e) {
    R(Qi, t._currentValue), t._currentValue = e;
  }
  function Qt(l) {
    l._currentValue = Qi.current, E(Qi);
  }
  function Zi(l, t, e) {
    for (; l !== null; ) {
      var a = l.alternate;
      if ((l.childLanes & t) !== t ? (l.childLanes |= t, a !== null && (a.childLanes |= t)) : a !== null && (a.childLanes & t) !== t && (a.childLanes |= t), l === e) break;
      l = l.return;
    }
  }
  function Vi(l, t, e, a) {
    var u = l.child;
    for (u !== null && (u.return = l); u !== null; ) {
      var n = u.dependencies;
      if (n !== null) {
        var i = u.child;
        n = n.firstContext;
        l: for (; n !== null; ) {
          var c = n;
          n = u;
          for (var s = 0; s < t.length; s++)
            if (c.context === t[s]) {
              n.lanes |= e, c = n.alternate, c !== null && (c.lanes |= e), Zi(
                n.return,
                e,
                l
              ), a || (i = null);
              break l;
            }
          n = c.next;
        }
      } else if (u.tag === 18) {
        if (i = u.return, i === null) throw Error(d(341));
        i.lanes |= e, n = i.alternate, n !== null && (n.lanes |= e), Zi(i, e, l), i = null;
      } else i = u.child;
      if (i !== null) i.return = u;
      else
        for (i = u; i !== null; ) {
          if (i === l) {
            i = null;
            break;
          }
          if (u = i.sibling, u !== null) {
            u.return = i.return, i = u;
            break;
          }
          i = i.return;
        }
      u = i;
    }
  }
  function ma(l, t, e, a) {
    l = null;
    for (var u = t, n = !1; u !== null; ) {
      if (!n) {
        if ((u.flags & 524288) !== 0) n = !0;
        else if ((u.flags & 262144) !== 0) break;
      }
      if (u.tag === 10) {
        var i = u.alternate;
        if (i === null) throw Error(d(387));
        if (i = i.memoizedProps, i !== null) {
          var c = u.type;
          ct(u.pendingProps.value, i.value) || (l !== null ? l.push(c) : l = [c]);
        }
      } else if (u === il.current) {
        if (i = u.alternate, i === null) throw Error(d(387));
        i.memoizedState.memoizedState !== u.memoizedState.memoizedState && (l !== null ? l.push(ju) : l = [ju]);
      }
      u = u.return;
    }
    l !== null && Vi(
      t,
      l,
      e,
      a
    ), t.flags |= 262144;
  }
  function ln(l) {
    for (l = l.firstContext; l !== null; ) {
      if (!ct(
        l.context._currentValue,
        l.memoizedValue
      ))
        return !0;
      l = l.next;
    }
    return !1;
  }
  function Ye(l) {
    Be = l, Xt = null, l = l.dependencies, l !== null && (l.firstContext = null);
  }
  function Gl(l) {
    return qs(Be, l);
  }
  function tn(l, t) {
    return Be === null && Ye(l), qs(l, t);
  }
  function qs(l, t) {
    var e = t._currentValue;
    if (t = { context: t, memoizedValue: e, next: null }, Xt === null) {
      if (l === null) throw Error(d(308));
      Xt = t, l.dependencies = { lanes: 0, firstContext: t }, l.flags |= 524288;
    } else Xt = Xt.next = t;
    return e;
  }
  var Im = typeof AbortController < "u" ? AbortController : function() {
    var l = [], t = this.signal = {
      aborted: !1,
      addEventListener: function(e, a) {
        l.push(a);
      }
    };
    this.abort = function() {
      t.aborted = !0, l.forEach(function(e) {
        return e();
      });
    };
  }, Pm = m.unstable_scheduleCallback, lh = m.unstable_NormalPriority, Ol = {
    $$typeof: Rl,
    Consumer: null,
    Provider: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0
  };
  function Ki() {
    return {
      controller: new Im(),
      data: /* @__PURE__ */ new Map(),
      refCount: 0
    };
  }
  function Ia(l) {
    l.refCount--, l.refCount === 0 && Pm(lh, function() {
      l.controller.abort();
    });
  }
  var Pa = null, Ji = 0, ha = 0, va = null;
  function th(l, t) {
    if (Pa === null) {
      var e = Pa = [];
      Ji = 0, ha = Wc(), va = {
        status: "pending",
        value: void 0,
        then: function(a) {
          e.push(a);
        }
      };
    }
    return Ji++, t.then(Bs, Bs), t;
  }
  function Bs() {
    if (--Ji === 0 && Pa !== null) {
      va !== null && (va.status = "fulfilled");
      var l = Pa;
      Pa = null, ha = 0, va = null;
      for (var t = 0; t < l.length; t++) (0, l[t])();
    }
  }
  function eh(l, t) {
    var e = [], a = {
      status: "pending",
      value: null,
      reason: null,
      then: function(u) {
        e.push(u);
      }
    };
    return l.then(
      function() {
        a.status = "fulfilled", a.value = t;
        for (var u = 0; u < e.length; u++) (0, e[u])(t);
      },
      function(u) {
        for (a.status = "rejected", a.reason = u, u = 0; u < e.length; u++)
          (0, e[u])(void 0);
      }
    ), a;
  }
  var Ys = A.S;
  A.S = function(l, t) {
    zd = ut(), typeof t == "object" && t !== null && typeof t.then == "function" && th(l, t), Ys !== null && Ys(l, t);
  };
  var Ge = r(null);
  function wi() {
    var l = Ge.current;
    return l !== null ? l : vl.pooledCache;
  }
  function en(l, t) {
    t === null ? R(Ge, Ge.current) : R(Ge, t.pool);
  }
  function Gs() {
    var l = wi();
    return l === null ? null : { parent: Ol._currentValue, pool: l };
  }
  var ya = Error(d(460)), $i = Error(d(474)), an = Error(d(542)), un = { then: function() {
  } };
  function Ls(l) {
    return l = l.status, l === "fulfilled" || l === "rejected";
  }
  function Xs(l, t, e) {
    switch (e = l[e], e === void 0 ? l.push(t) : e !== t && (t.then(Bt, Bt), t = e), t.status) {
      case "fulfilled":
        return t.value;
      case "rejected":
        throw l = t.reason, Zs(l), l;
      default:
        if (typeof t.status == "string") t.then(Bt, Bt);
        else {
          if (l = vl, l !== null && 100 < l.shellSuspendCounter)
            throw Error(d(482));
          l = t, l.status = "pending", l.then(
            function(a) {
              if (t.status === "pending") {
                var u = t;
                u.status = "fulfilled", u.value = a;
              }
            },
            function(a) {
              if (t.status === "pending") {
                var u = t;
                u.status = "rejected", u.reason = a;
              }
            }
          );
        }
        switch (t.status) {
          case "fulfilled":
            return t.value;
          case "rejected":
            throw l = t.reason, Zs(l), l;
        }
        throw Xe = t, ya;
    }
  }
  function Le(l) {
    try {
      var t = l._init;
      return t(l._payload);
    } catch (e) {
      throw e !== null && typeof e == "object" && typeof e.then == "function" ? (Xe = e, ya) : e;
    }
  }
  var Xe = null;
  function Qs() {
    if (Xe === null) throw Error(d(459));
    var l = Xe;
    return Xe = null, l;
  }
  function Zs(l) {
    if (l === ya || l === an)
      throw Error(d(483));
  }
  var ga = null, lu = 0;
  function nn(l) {
    var t = lu;
    return lu += 1, ga === null && (ga = []), Xs(ga, l, t);
  }
  function tu(l, t) {
    t = t.props.ref, l.ref = t !== void 0 ? t : null;
  }
  function cn(l, t) {
    throw t.$$typeof === N ? Error(d(525)) : (l = Object.prototype.toString.call(t), Error(
      d(
        31,
        l === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : l
      )
    ));
  }
  function Vs(l) {
    function t(h, o) {
      if (l) {
        var v = h.deletions;
        v === null ? (h.deletions = [o], h.flags |= 16) : v.push(o);
      }
    }
    function e(h, o) {
      if (!l) return null;
      for (; o !== null; )
        t(h, o), o = o.sibling;
      return null;
    }
    function a(h) {
      for (var o = /* @__PURE__ */ new Map(); h !== null; )
        h.key !== null ? o.set(h.key, h) : o.set(h.index, h), h = h.sibling;
      return o;
    }
    function u(h, o) {
      return h = Gt(h, o), h.index = 0, h.sibling = null, h;
    }
    function n(h, o, v) {
      return h.index = v, l ? (v = h.alternate, v !== null ? (v = v.index, v < o ? (h.flags |= 67108866, o) : v) : (h.flags |= 67108866, o)) : (h.flags |= 1048576, o);
    }
    function i(h) {
      return l && h.alternate === null && (h.flags |= 67108866), h;
    }
    function c(h, o, v, T) {
      return o === null || o.tag !== 6 ? (o = qi(v, h.mode, T), o.return = h, o) : (o = u(o, v), o.return = h, o);
    }
    function s(h, o, v, T) {
      var G = v.type;
      return G === xl ? b(
        h,
        o,
        v.props.children,
        T,
        v.key
      ) : o !== null && (o.elementType === G || typeof G == "object" && G !== null && G.$$typeof === Cl && Le(G) === o.type) ? (o = u(o, v.props), tu(o, v), o.return = h, o) : (o = Iu(
        v.type,
        v.key,
        v.props,
        null,
        h.mode,
        T
      ), tu(o, v), o.return = h, o);
    }
    function y(h, o, v, T) {
      return o === null || o.tag !== 4 || o.stateNode.containerInfo !== v.containerInfo || o.stateNode.implementation !== v.implementation ? (o = Bi(v, h.mode, T), o.return = h, o) : (o = u(o, v.children || []), o.return = h, o);
    }
    function b(h, o, v, T, G) {
      return o === null || o.tag !== 7 ? (o = He(
        v,
        h.mode,
        T,
        G
      ), o.return = h, o) : (o = u(o, v), o.return = h, o);
    }
    function j(h, o, v) {
      if (typeof o == "string" && o !== "" || typeof o == "number" || typeof o == "bigint")
        return o = qi(
          "" + o,
          h.mode,
          v
        ), o.return = h, o;
      if (typeof o == "object" && o !== null) {
        switch (o.$$typeof) {
          case Y:
            return v = Iu(
              o.type,
              o.key,
              o.props,
              null,
              h.mode,
              v
            ), tu(v, o), v.return = h, v;
          case El:
            return o = Bi(
              o,
              h.mode,
              v
            ), o.return = h, o;
          case Cl:
            return o = Le(o), j(h, o, v);
        }
        if (Et(o) || $l(o))
          return o = He(
            o,
            h.mode,
            v,
            null
          ), o.return = h, o;
        if (typeof o.then == "function")
          return j(h, nn(o), v);
        if (o.$$typeof === Rl)
          return j(
            h,
            tn(h, o),
            v
          );
        cn(h, o);
      }
      return null;
    }
    function g(h, o, v, T) {
      var G = o !== null ? o.key : null;
      if (typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint")
        return G !== null ? null : c(h, o, "" + v, T);
      if (typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case Y:
            return v.key === G ? s(h, o, v, T) : null;
          case El:
            return v.key === G ? y(h, o, v, T) : null;
          case Cl:
            return v = Le(v), g(h, o, v, T);
        }
        if (Et(v) || $l(v))
          return G !== null ? null : b(h, o, v, T, null);
        if (typeof v.then == "function")
          return g(
            h,
            o,
            nn(v),
            T
          );
        if (v.$$typeof === Rl)
          return g(
            h,
            o,
            tn(h, v),
            T
          );
        cn(h, v);
      }
      return null;
    }
    function S(h, o, v, T, G) {
      if (typeof T == "string" && T !== "" || typeof T == "number" || typeof T == "bigint")
        return h = h.get(v) || null, c(o, h, "" + T, G);
      if (typeof T == "object" && T !== null) {
        switch (T.$$typeof) {
          case Y:
            return h = h.get(
              T.key === null ? v : T.key
            ) || null, s(o, h, T, G);
          case El:
            return h = h.get(
              T.key === null ? v : T.key
            ) || null, y(o, h, T, G);
          case Cl:
            return T = Le(T), S(
              h,
              o,
              v,
              T,
              G
            );
        }
        if (Et(T) || $l(T))
          return h = h.get(v) || null, b(o, h, T, G, null);
        if (typeof T.then == "function")
          return S(
            h,
            o,
            v,
            nn(T),
            G
          );
        if (T.$$typeof === Rl)
          return S(
            h,
            o,
            v,
            tn(o, T),
            G
          );
        cn(o, T);
      }
      return null;
    }
    function H(h, o, v, T) {
      for (var G = null, al = null, B = o, W = o = 0, ll = null; B !== null && W < v.length; W++) {
        B.index > W ? (ll = B, B = null) : ll = B.sibling;
        var ul = g(
          h,
          B,
          v[W],
          T
        );
        if (ul === null) {
          B === null && (B = ll);
          break;
        }
        l && B && ul.alternate === null && t(h, B), o = n(ul, o, W), al === null ? G = ul : al.sibling = ul, al = ul, B = ll;
      }
      if (W === v.length)
        return e(h, B), el && Lt(h, W), G;
      if (B === null) {
        for (; W < v.length; W++)
          B = j(h, v[W], T), B !== null && (o = n(
            B,
            o,
            W
          ), al === null ? G = B : al.sibling = B, al = B);
        return el && Lt(h, W), G;
      }
      for (B = a(B); W < v.length; W++)
        ll = S(
          B,
          h,
          W,
          v[W],
          T
        ), ll !== null && (l && ll.alternate !== null && B.delete(
          ll.key === null ? W : ll.key
        ), o = n(
          ll,
          o,
          W
        ), al === null ? G = ll : al.sibling = ll, al = ll);
      return l && B.forEach(function(Ee) {
        return t(h, Ee);
      }), el && Lt(h, W), G;
    }
    function L(h, o, v, T) {
      if (v == null) throw Error(d(151));
      for (var G = null, al = null, B = o, W = o = 0, ll = null, ul = v.next(); B !== null && !ul.done; W++, ul = v.next()) {
        B.index > W ? (ll = B, B = null) : ll = B.sibling;
        var Ee = g(h, B, ul.value, T);
        if (Ee === null) {
          B === null && (B = ll);
          break;
        }
        l && B && Ee.alternate === null && t(h, B), o = n(Ee, o, W), al === null ? G = Ee : al.sibling = Ee, al = Ee, B = ll;
      }
      if (ul.done)
        return e(h, B), el && Lt(h, W), G;
      if (B === null) {
        for (; !ul.done; W++, ul = v.next())
          ul = j(h, ul.value, T), ul !== null && (o = n(ul, o, W), al === null ? G = ul : al.sibling = ul, al = ul);
        return el && Lt(h, W), G;
      }
      for (B = a(B); !ul.done; W++, ul = v.next())
        ul = S(B, h, W, ul.value, T), ul !== null && (l && ul.alternate !== null && B.delete(ul.key === null ? W : ul.key), o = n(ul, o, W), al === null ? G = ul : al.sibling = ul, al = ul);
      return l && B.forEach(function(mv) {
        return t(h, mv);
      }), el && Lt(h, W), G;
    }
    function ml(h, o, v, T) {
      if (typeof v == "object" && v !== null && v.type === xl && v.key === null && (v = v.props.children), typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case Y:
            l: {
              for (var G = v.key; o !== null; ) {
                if (o.key === G) {
                  if (G = v.type, G === xl) {
                    if (o.tag === 7) {
                      e(
                        h,
                        o.sibling
                      ), T = u(
                        o,
                        v.props.children
                      ), T.return = h, h = T;
                      break l;
                    }
                  } else if (o.elementType === G || typeof G == "object" && G !== null && G.$$typeof === Cl && Le(G) === o.type) {
                    e(
                      h,
                      o.sibling
                    ), T = u(o, v.props), tu(T, v), T.return = h, h = T;
                    break l;
                  }
                  e(h, o);
                  break;
                } else t(h, o);
                o = o.sibling;
              }
              v.type === xl ? (T = He(
                v.props.children,
                h.mode,
                T,
                v.key
              ), T.return = h, h = T) : (T = Iu(
                v.type,
                v.key,
                v.props,
                null,
                h.mode,
                T
              ), tu(T, v), T.return = h, h = T);
            }
            return i(h);
          case El:
            l: {
              for (G = v.key; o !== null; ) {
                if (o.key === G)
                  if (o.tag === 4 && o.stateNode.containerInfo === v.containerInfo && o.stateNode.implementation === v.implementation) {
                    e(
                      h,
                      o.sibling
                    ), T = u(o, v.children || []), T.return = h, h = T;
                    break l;
                  } else {
                    e(h, o);
                    break;
                  }
                else t(h, o);
                o = o.sibling;
              }
              T = Bi(v, h.mode, T), T.return = h, h = T;
            }
            return i(h);
          case Cl:
            return v = Le(v), ml(
              h,
              o,
              v,
              T
            );
        }
        if (Et(v))
          return H(
            h,
            o,
            v,
            T
          );
        if ($l(v)) {
          if (G = $l(v), typeof G != "function") throw Error(d(150));
          return v = G.call(v), L(
            h,
            o,
            v,
            T
          );
        }
        if (typeof v.then == "function")
          return ml(
            h,
            o,
            nn(v),
            T
          );
        if (v.$$typeof === Rl)
          return ml(
            h,
            o,
            tn(h, v),
            T
          );
        cn(h, v);
      }
      return typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint" ? (v = "" + v, o !== null && o.tag === 6 ? (e(h, o.sibling), T = u(o, v), T.return = h, h = T) : (e(h, o), T = qi(v, h.mode, T), T.return = h, h = T), i(h)) : e(h, o);
    }
    return function(h, o, v, T) {
      try {
        lu = 0;
        var G = ml(
          h,
          o,
          v,
          T
        );
        return ga = null, G;
      } catch (B) {
        if (B === ya || B === an) throw B;
        var al = ft(29, B, null, h.mode);
        return al.lanes = T, al.return = h, al;
      }
    };
  }
  var Qe = Vs(!0), Ks = Vs(!1), fe = !1;
  function Wi(l) {
    l.updateQueue = {
      baseState: l.memoizedState,
      firstBaseUpdate: null,
      lastBaseUpdate: null,
      shared: { pending: null, lanes: 0, hiddenCallbacks: null },
      callbacks: null
    };
  }
  function ki(l, t) {
    l = l.updateQueue, t.updateQueue === l && (t.updateQueue = {
      baseState: l.baseState,
      firstBaseUpdate: l.firstBaseUpdate,
      lastBaseUpdate: l.lastBaseUpdate,
      shared: l.shared,
      callbacks: null
    });
  }
  function se(l) {
    return { lane: l, tag: 0, payload: null, callback: null, next: null };
  }
  function oe(l, t, e) {
    var a = l.updateQueue;
    if (a === null) return null;
    if (a = a.shared, (nl & 2) !== 0) {
      var u = a.pending;
      return u === null ? t.next = t : (t.next = u.next, u.next = t), a.pending = t, t = Fu(l), Os(l, null, e), t;
    }
    return ku(l, a, t, e), Fu(l);
  }
  function eu(l, t, e) {
    if (t = t.updateQueue, t !== null && (t = t.shared, (e & 4194048) !== 0)) {
      var a = t.lanes;
      a &= l.pendingLanes, e |= a, t.lanes = e, qf(l, e);
    }
  }
  function Fi(l, t) {
    var e = l.updateQueue, a = l.alternate;
    if (a !== null && (a = a.updateQueue, e === a)) {
      var u = null, n = null;
      if (e = e.firstBaseUpdate, e !== null) {
        do {
          var i = {
            lane: e.lane,
            tag: e.tag,
            payload: e.payload,
            callback: null,
            next: null
          };
          n === null ? u = n = i : n = n.next = i, e = e.next;
        } while (e !== null);
        n === null ? u = n = t : n = n.next = t;
      } else u = n = t;
      e = {
        baseState: a.baseState,
        firstBaseUpdate: u,
        lastBaseUpdate: n,
        shared: a.shared,
        callbacks: a.callbacks
      }, l.updateQueue = e;
      return;
    }
    l = e.lastBaseUpdate, l === null ? e.firstBaseUpdate = t : l.next = t, e.lastBaseUpdate = t;
  }
  var Ii = !1;
  function au() {
    if (Ii) {
      var l = va;
      if (l !== null) throw l;
    }
  }
  function uu(l, t, e, a) {
    Ii = !1;
    var u = l.updateQueue;
    fe = !1;
    var n = u.firstBaseUpdate, i = u.lastBaseUpdate, c = u.shared.pending;
    if (c !== null) {
      u.shared.pending = null;
      var s = c, y = s.next;
      s.next = null, i === null ? n = y : i.next = y, i = s;
      var b = l.alternate;
      b !== null && (b = b.updateQueue, c = b.lastBaseUpdate, c !== i && (c === null ? b.firstBaseUpdate = y : c.next = y, b.lastBaseUpdate = s));
    }
    if (n !== null) {
      var j = u.baseState;
      i = 0, b = y = s = null, c = n;
      do {
        var g = c.lane & -536870913, S = g !== c.lane;
        if (S ? (P & g) === g : (a & g) === g) {
          g !== 0 && g === ha && (Ii = !0), b !== null && (b = b.next = {
            lane: 0,
            tag: c.tag,
            payload: c.payload,
            callback: null,
            next: null
          });
          l: {
            var H = l, L = c;
            g = t;
            var ml = e;
            switch (L.tag) {
              case 1:
                if (H = L.payload, typeof H == "function") {
                  j = H.call(ml, j, g);
                  break l;
                }
                j = H;
                break l;
              case 3:
                H.flags = H.flags & -65537 | 128;
              case 0:
                if (H = L.payload, g = typeof H == "function" ? H.call(ml, j, g) : H, g == null) break l;
                j = p({}, j, g);
                break l;
              case 2:
                fe = !0;
            }
          }
          g = c.callback, g !== null && (l.flags |= 64, S && (l.flags |= 8192), S = u.callbacks, S === null ? u.callbacks = [g] : S.push(g));
        } else
          S = {
            lane: g,
            tag: c.tag,
            payload: c.payload,
            callback: c.callback,
            next: null
          }, b === null ? (y = b = S, s = j) : b = b.next = S, i |= g;
        if (c = c.next, c === null) {
          if (c = u.shared.pending, c === null)
            break;
          S = c, c = S.next, S.next = null, u.lastBaseUpdate = S, u.shared.pending = null;
        }
      } while (!0);
      b === null && (s = j), u.baseState = s, u.firstBaseUpdate = y, u.lastBaseUpdate = b, n === null && (u.shared.lanes = 0), ve |= i, l.lanes = i, l.memoizedState = j;
    }
  }
  function Js(l, t) {
    if (typeof l != "function")
      throw Error(d(191, l));
    l.call(t);
  }
  function ws(l, t) {
    var e = l.callbacks;
    if (e !== null)
      for (l.callbacks = null, l = 0; l < e.length; l++)
        Js(e[l], t);
  }
  var Sa = r(null), fn = r(0);
  function $s(l, t) {
    l = Ft, R(fn, l), R(Sa, t), Ft = l | t.baseLanes;
  }
  function Pi() {
    R(fn, Ft), R(Sa, Sa.current);
  }
  function lc() {
    Ft = fn.current, E(Sa), E(fn);
  }
  var st = r(null), zt = null;
  function de(l) {
    var t = l.alternate;
    R(Tl, Tl.current & 1), R(st, l), zt === null && (t === null || Sa.current !== null || t.memoizedState !== null) && (zt = l);
  }
  function tc(l) {
    R(Tl, Tl.current), R(st, l), zt === null && (zt = l);
  }
  function Ws(l) {
    l.tag === 22 ? (R(Tl, Tl.current), R(st, l), zt === null && (zt = l)) : re();
  }
  function re() {
    R(Tl, Tl.current), R(st, st.current);
  }
  function ot(l) {
    E(st), zt === l && (zt = null), E(Tl);
  }
  var Tl = r(0);
  function sn(l) {
    for (var t = l; t !== null; ) {
      if (t.tag === 13) {
        var e = t.memoizedState;
        if (e !== null && (e = e.dehydrated, e === null || ff(e) || sf(e)))
          return t;
      } else if (t.tag === 19 && (t.memoizedProps.revealOrder === "forwards" || t.memoizedProps.revealOrder === "backwards" || t.memoizedProps.revealOrder === "unstable_legacy-backwards" || t.memoizedProps.revealOrder === "together")) {
        if ((t.flags & 128) !== 0) return t;
      } else if (t.child !== null) {
        t.child.return = t, t = t.child;
        continue;
      }
      if (t === l) break;
      for (; t.sibling === null; ) {
        if (t.return === null || t.return === l) return null;
        t = t.return;
      }
      t.sibling.return = t.return, t = t.sibling;
    }
    return null;
  }
  var Zt = 0, w = null, dl = null, _l = null, on = !1, ba = !1, Ze = !1, dn = 0, nu = 0, pa = null, ah = 0;
  function pl() {
    throw Error(d(321));
  }
  function ec(l, t) {
    if (t === null) return !1;
    for (var e = 0; e < t.length && e < l.length; e++)
      if (!ct(l[e], t[e])) return !1;
    return !0;
  }
  function ac(l, t, e, a, u, n) {
    return Zt = n, w = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, A.H = l === null || l.memoizedState === null ? Ro : Sc, Ze = !1, n = e(a, u), Ze = !1, ba && (n = Fs(
      t,
      e,
      a,
      u
    )), ks(l), n;
  }
  function ks(l) {
    A.H = fu;
    var t = dl !== null && dl.next !== null;
    if (Zt = 0, _l = dl = w = null, on = !1, nu = 0, pa = null, t) throw Error(d(300));
    l === null || Ml || (l = l.dependencies, l !== null && ln(l) && (Ml = !0));
  }
  function Fs(l, t, e, a) {
    w = l;
    var u = 0;
    do {
      if (ba && (pa = null), nu = 0, ba = !1, 25 <= u) throw Error(d(301));
      if (u += 1, _l = dl = null, l.updateQueue != null) {
        var n = l.updateQueue;
        n.lastEffect = null, n.events = null, n.stores = null, n.memoCache != null && (n.memoCache.index = 0);
      }
      A.H = Co, n = t(e, a);
    } while (ba);
    return n;
  }
  function uh() {
    var l = A.H, t = l.useState()[0];
    return t = typeof t.then == "function" ? iu(t) : t, l = l.useState()[0], (dl !== null ? dl.memoizedState : null) !== l && (w.flags |= 1024), t;
  }
  function uc() {
    var l = dn !== 0;
    return dn = 0, l;
  }
  function nc(l, t, e) {
    t.updateQueue = l.updateQueue, t.flags &= -2053, l.lanes &= ~e;
  }
  function ic(l) {
    if (on) {
      for (l = l.memoizedState; l !== null; ) {
        var t = l.queue;
        t !== null && (t.pending = null), l = l.next;
      }
      on = !1;
    }
    Zt = 0, _l = dl = w = null, ba = !1, nu = dn = 0, pa = null;
  }
  function Vl() {
    var l = {
      memoizedState: null,
      baseState: null,
      baseQueue: null,
      queue: null,
      next: null
    };
    return _l === null ? w.memoizedState = _l = l : _l = _l.next = l, _l;
  }
  function jl() {
    if (dl === null) {
      var l = w.alternate;
      l = l !== null ? l.memoizedState : null;
    } else l = dl.next;
    var t = _l === null ? w.memoizedState : _l.next;
    if (t !== null)
      _l = t, dl = l;
    else {
      if (l === null)
        throw w.alternate === null ? Error(d(467)) : Error(d(310));
      dl = l, l = {
        memoizedState: dl.memoizedState,
        baseState: dl.baseState,
        baseQueue: dl.baseQueue,
        queue: dl.queue,
        next: null
      }, _l === null ? w.memoizedState = _l = l : _l = _l.next = l;
    }
    return _l;
  }
  function rn() {
    return { lastEffect: null, events: null, stores: null, memoCache: null };
  }
  function iu(l) {
    var t = nu;
    return nu += 1, pa === null && (pa = []), l = Xs(pa, l, t), t = w, (_l === null ? t.memoizedState : _l.next) === null && (t = t.alternate, A.H = t === null || t.memoizedState === null ? Ro : Sc), l;
  }
  function mn(l) {
    if (l !== null && typeof l == "object") {
      if (typeof l.then == "function") return iu(l);
      if (l.$$typeof === Rl) return Gl(l);
    }
    throw Error(d(438, String(l)));
  }
  function cc(l) {
    var t = null, e = w.updateQueue;
    if (e !== null && (t = e.memoCache), t == null) {
      var a = w.alternate;
      a !== null && (a = a.updateQueue, a !== null && (a = a.memoCache, a != null && (t = {
        data: a.data.map(function(u) {
          return u.slice();
        }),
        index: 0
      })));
    }
    if (t == null && (t = { data: [], index: 0 }), e === null && (e = rn(), w.updateQueue = e), e.memoCache = t, e = t.data[t.index], e === void 0)
      for (e = t.data[t.index] = Array(l), a = 0; a < l; a++)
        e[a] = We;
    return t.index++, e;
  }
  function Vt(l, t) {
    return typeof t == "function" ? t(l) : t;
  }
  function hn(l) {
    var t = jl();
    return fc(t, dl, l);
  }
  function fc(l, t, e) {
    var a = l.queue;
    if (a === null) throw Error(d(311));
    a.lastRenderedReducer = e;
    var u = l.baseQueue, n = a.pending;
    if (n !== null) {
      if (u !== null) {
        var i = u.next;
        u.next = n.next, n.next = i;
      }
      t.baseQueue = u = n, a.pending = null;
    }
    if (n = l.baseState, u === null) l.memoizedState = n;
    else {
      t = u.next;
      var c = i = null, s = null, y = t, b = !1;
      do {
        var j = y.lane & -536870913;
        if (j !== y.lane ? (P & j) === j : (Zt & j) === j) {
          var g = y.revertLane;
          if (g === 0)
            s !== null && (s = s.next = {
              lane: 0,
              revertLane: 0,
              gesture: null,
              action: y.action,
              hasEagerState: y.hasEagerState,
              eagerState: y.eagerState,
              next: null
            }), j === ha && (b = !0);
          else if ((Zt & g) === g) {
            y = y.next, g === ha && (b = !0);
            continue;
          } else
            j = {
              lane: 0,
              revertLane: y.revertLane,
              gesture: null,
              action: y.action,
              hasEagerState: y.hasEagerState,
              eagerState: y.eagerState,
              next: null
            }, s === null ? (c = s = j, i = n) : s = s.next = j, w.lanes |= g, ve |= g;
          j = y.action, Ze && e(n, j), n = y.hasEagerState ? y.eagerState : e(n, j);
        } else
          g = {
            lane: j,
            revertLane: y.revertLane,
            gesture: y.gesture,
            action: y.action,
            hasEagerState: y.hasEagerState,
            eagerState: y.eagerState,
            next: null
          }, s === null ? (c = s = g, i = n) : s = s.next = g, w.lanes |= j, ve |= j;
        y = y.next;
      } while (y !== null && y !== t);
      if (s === null ? i = n : s.next = c, !ct(n, l.memoizedState) && (Ml = !0, b && (e = va, e !== null)))
        throw e;
      l.memoizedState = n, l.baseState = i, l.baseQueue = s, a.lastRenderedState = n;
    }
    return u === null && (a.lanes = 0), [l.memoizedState, a.dispatch];
  }
  function sc(l) {
    var t = jl(), e = t.queue;
    if (e === null) throw Error(d(311));
    e.lastRenderedReducer = l;
    var a = e.dispatch, u = e.pending, n = t.memoizedState;
    if (u !== null) {
      e.pending = null;
      var i = u = u.next;
      do
        n = l(n, i.action), i = i.next;
      while (i !== u);
      ct(n, t.memoizedState) || (Ml = !0), t.memoizedState = n, t.baseQueue === null && (t.baseState = n), e.lastRenderedState = n;
    }
    return [n, a];
  }
  function Is(l, t, e) {
    var a = w, u = jl(), n = el;
    if (n) {
      if (e === void 0) throw Error(d(407));
      e = e();
    } else e = t();
    var i = !ct(
      (dl || u).memoizedState,
      e
    );
    if (i && (u.memoizedState = e, Ml = !0), u = u.queue, rc(to.bind(null, a, u, l), [
      l
    ]), u.getSnapshot !== t || i || _l !== null && _l.memoizedState.tag & 1) {
      if (a.flags |= 2048, Aa(
        9,
        { destroy: void 0 },
        lo.bind(
          null,
          a,
          u,
          e,
          t
        ),
        null
      ), vl === null) throw Error(d(349));
      n || (Zt & 127) !== 0 || Ps(a, t, e);
    }
    return e;
  }
  function Ps(l, t, e) {
    l.flags |= 16384, l = { getSnapshot: t, value: e }, t = w.updateQueue, t === null ? (t = rn(), w.updateQueue = t, t.stores = [l]) : (e = t.stores, e === null ? t.stores = [l] : e.push(l));
  }
  function lo(l, t, e, a) {
    t.value = e, t.getSnapshot = a, eo(t) && ao(l);
  }
  function to(l, t, e) {
    return e(function() {
      eo(t) && ao(l);
    });
  }
  function eo(l) {
    var t = l.getSnapshot;
    l = l.value;
    try {
      var e = t();
      return !ct(l, e);
    } catch {
      return !0;
    }
  }
  function ao(l) {
    var t = Ce(l, 2);
    t !== null && tt(t, l, 2);
  }
  function oc(l) {
    var t = Vl();
    if (typeof l == "function") {
      var e = l;
      if (l = e(), Ze) {
        te(!0);
        try {
          e();
        } finally {
          te(!1);
        }
      }
    }
    return t.memoizedState = t.baseState = l, t.queue = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: Vt,
      lastRenderedState: l
    }, t;
  }
  function uo(l, t, e, a) {
    return l.baseState = e, fc(
      l,
      dl,
      typeof a == "function" ? a : Vt
    );
  }
  function nh(l, t, e, a, u) {
    if (gn(l)) throw Error(d(485));
    if (l = t.action, l !== null) {
      var n = {
        payload: u,
        action: l,
        next: null,
        isTransition: !0,
        status: "pending",
        value: null,
        reason: null,
        listeners: [],
        then: function(i) {
          n.listeners.push(i);
        }
      };
      A.T !== null ? e(!0) : n.isTransition = !1, a(n), e = t.pending, e === null ? (n.next = t.pending = n, no(t, n)) : (n.next = e.next, t.pending = e.next = n);
    }
  }
  function no(l, t) {
    var e = t.action, a = t.payload, u = l.state;
    if (t.isTransition) {
      var n = A.T, i = {};
      A.T = i;
      try {
        var c = e(u, a), s = A.S;
        s !== null && s(i, c), io(l, t, c);
      } catch (y) {
        dc(l, t, y);
      } finally {
        n !== null && i.types !== null && (n.types = i.types), A.T = n;
      }
    } else
      try {
        n = e(u, a), io(l, t, n);
      } catch (y) {
        dc(l, t, y);
      }
  }
  function io(l, t, e) {
    e !== null && typeof e == "object" && typeof e.then == "function" ? e.then(
      function(a) {
        co(l, t, a);
      },
      function(a) {
        return dc(l, t, a);
      }
    ) : co(l, t, e);
  }
  function co(l, t, e) {
    t.status = "fulfilled", t.value = e, fo(t), l.state = e, t = l.pending, t !== null && (e = t.next, e === t ? l.pending = null : (e = e.next, t.next = e, no(l, e)));
  }
  function dc(l, t, e) {
    var a = l.pending;
    if (l.pending = null, a !== null) {
      a = a.next;
      do
        t.status = "rejected", t.reason = e, fo(t), t = t.next;
      while (t !== a);
    }
    l.action = null;
  }
  function fo(l) {
    l = l.listeners;
    for (var t = 0; t < l.length; t++) (0, l[t])();
  }
  function so(l, t) {
    return t;
  }
  function oo(l, t) {
    if (el) {
      var e = vl.formState;
      if (e !== null) {
        l: {
          var a = w;
          if (el) {
            if (yl) {
              t: {
                for (var u = yl, n = At; u.nodeType !== 8; ) {
                  if (!n) {
                    u = null;
                    break t;
                  }
                  if (u = Tt(
                    u.nextSibling
                  ), u === null) {
                    u = null;
                    break t;
                  }
                }
                n = u.data, u = n === "F!" || n === "F" ? u : null;
              }
              if (u) {
                yl = Tt(
                  u.nextSibling
                ), a = u.data === "F!";
                break l;
              }
            }
            ie(a);
          }
          a = !1;
        }
        a && (t = e[0]);
      }
    }
    return e = Vl(), e.memoizedState = e.baseState = t, a = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: so,
      lastRenderedState: t
    }, e.queue = a, e = Mo.bind(
      null,
      w,
      a
    ), a.dispatch = e, a = oc(!1), n = gc.bind(
      null,
      w,
      !1,
      a.queue
    ), a = Vl(), u = {
      state: t,
      dispatch: null,
      action: l,
      pending: null
    }, a.queue = u, e = nh.bind(
      null,
      w,
      u,
      n,
      e
    ), u.dispatch = e, a.memoizedState = l, [t, e, !1];
  }
  function ro(l) {
    var t = jl();
    return mo(t, dl, l);
  }
  function mo(l, t, e) {
    if (t = fc(
      l,
      t,
      so
    )[0], l = hn(Vt)[0], typeof t == "object" && t !== null && typeof t.then == "function")
      try {
        var a = iu(t);
      } catch (i) {
        throw i === ya ? an : i;
      }
    else a = t;
    t = jl();
    var u = t.queue, n = u.dispatch;
    return e !== t.memoizedState && (w.flags |= 2048, Aa(
      9,
      { destroy: void 0 },
      ih.bind(null, u, e),
      null
    )), [a, n, l];
  }
  function ih(l, t) {
    l.action = t;
  }
  function ho(l) {
    var t = jl(), e = dl;
    if (e !== null)
      return mo(t, e, l);
    jl(), t = t.memoizedState, e = jl();
    var a = e.queue.dispatch;
    return e.memoizedState = l, [t, a, !1];
  }
  function Aa(l, t, e, a) {
    return l = { tag: l, create: e, deps: a, inst: t, next: null }, t = w.updateQueue, t === null && (t = rn(), w.updateQueue = t), e = t.lastEffect, e === null ? t.lastEffect = l.next = l : (a = e.next, e.next = l, l.next = a, t.lastEffect = l), l;
  }
  function vo() {
    return jl().memoizedState;
  }
  function vn(l, t, e, a) {
    var u = Vl();
    w.flags |= l, u.memoizedState = Aa(
      1 | t,
      { destroy: void 0 },
      e,
      a === void 0 ? null : a
    );
  }
  function yn(l, t, e, a) {
    var u = jl();
    a = a === void 0 ? null : a;
    var n = u.memoizedState.inst;
    dl !== null && a !== null && ec(a, dl.memoizedState.deps) ? u.memoizedState = Aa(t, n, e, a) : (w.flags |= l, u.memoizedState = Aa(
      1 | t,
      n,
      e,
      a
    ));
  }
  function yo(l, t) {
    vn(8390656, 8, l, t);
  }
  function rc(l, t) {
    yn(2048, 8, l, t);
  }
  function ch(l) {
    w.flags |= 4;
    var t = w.updateQueue;
    if (t === null)
      t = rn(), w.updateQueue = t, t.events = [l];
    else {
      var e = t.events;
      e === null ? t.events = [l] : e.push(l);
    }
  }
  function go(l) {
    var t = jl().memoizedState;
    return ch({ ref: t, nextImpl: l }), function() {
      if ((nl & 2) !== 0) throw Error(d(440));
      return t.impl.apply(void 0, arguments);
    };
  }
  function So(l, t) {
    return yn(4, 2, l, t);
  }
  function bo(l, t) {
    return yn(4, 4, l, t);
  }
  function po(l, t) {
    if (typeof t == "function") {
      l = l();
      var e = t(l);
      return function() {
        typeof e == "function" ? e() : t(null);
      };
    }
    if (t != null)
      return l = l(), t.current = l, function() {
        t.current = null;
      };
  }
  function Ao(l, t, e) {
    e = e != null ? e.concat([l]) : null, yn(4, 4, po.bind(null, t, l), e);
  }
  function mc() {
  }
  function zo(l, t) {
    var e = jl();
    t = t === void 0 ? null : t;
    var a = e.memoizedState;
    return t !== null && ec(t, a[1]) ? a[0] : (e.memoizedState = [l, t], l);
  }
  function To(l, t) {
    var e = jl();
    t = t === void 0 ? null : t;
    var a = e.memoizedState;
    if (t !== null && ec(t, a[1]))
      return a[0];
    if (a = l(), Ze) {
      te(!0);
      try {
        l();
      } finally {
        te(!1);
      }
    }
    return e.memoizedState = [a, t], a;
  }
  function hc(l, t, e) {
    return e === void 0 || (Zt & 1073741824) !== 0 && (P & 261930) === 0 ? l.memoizedState = t : (l.memoizedState = e, l = jd(), w.lanes |= l, ve |= l, e);
  }
  function jo(l, t, e, a) {
    return ct(e, t) ? e : Sa.current !== null ? (l = hc(l, e, a), ct(l, t) || (Ml = !0), l) : (Zt & 42) === 0 || (Zt & 1073741824) !== 0 && (P & 261930) === 0 ? (Ml = !0, l.memoizedState = e) : (l = jd(), w.lanes |= l, ve |= l, t);
  }
  function Eo(l, t, e, a, u) {
    var n = U.p;
    U.p = n !== 0 && 8 > n ? n : 8;
    var i = A.T, c = {};
    A.T = c, gc(l, !1, t, e);
    try {
      var s = u(), y = A.S;
      if (y !== null && y(c, s), s !== null && typeof s == "object" && typeof s.then == "function") {
        var b = eh(
          s,
          a
        );
        cu(
          l,
          t,
          b,
          mt(l)
        );
      } else
        cu(
          l,
          t,
          a,
          mt(l)
        );
    } catch (j) {
      cu(
        l,
        t,
        { then: function() {
        }, status: "rejected", reason: j },
        mt()
      );
    } finally {
      U.p = n, i !== null && c.types !== null && (i.types = c.types), A.T = i;
    }
  }
  function fh() {
  }
  function vc(l, t, e, a) {
    if (l.tag !== 5) throw Error(d(476));
    var u = xo(l).queue;
    Eo(
      l,
      u,
      t,
      Z,
      e === null ? fh : function() {
        return No(l), e(a);
      }
    );
  }
  function xo(l) {
    var t = l.memoizedState;
    if (t !== null) return t;
    t = {
      memoizedState: Z,
      baseState: Z,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Vt,
        lastRenderedState: Z
      },
      next: null
    };
    var e = {};
    return t.next = {
      memoizedState: e,
      baseState: e,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Vt,
        lastRenderedState: e
      },
      next: null
    }, l.memoizedState = t, l = l.alternate, l !== null && (l.memoizedState = t), t;
  }
  function No(l) {
    var t = xo(l);
    t.next === null && (t = l.alternate.memoizedState), cu(
      l,
      t.next.queue,
      {},
      mt()
    );
  }
  function yc() {
    return Gl(ju);
  }
  function Oo() {
    return jl().memoizedState;
  }
  function _o() {
    return jl().memoizedState;
  }
  function sh(l) {
    for (var t = l.return; t !== null; ) {
      switch (t.tag) {
        case 24:
        case 3:
          var e = mt();
          l = se(e);
          var a = oe(t, l, e);
          a !== null && (tt(a, t, e), eu(a, t, e)), t = { cache: Ki() }, l.payload = t;
          return;
      }
      t = t.return;
    }
  }
  function oh(l, t, e) {
    var a = mt();
    e = {
      lane: a,
      revertLane: 0,
      gesture: null,
      action: e,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, gn(l) ? Do(t, e) : (e = Ci(l, t, e, a), e !== null && (tt(e, l, a), Uo(e, t, a)));
  }
  function Mo(l, t, e) {
    var a = mt();
    cu(l, t, e, a);
  }
  function cu(l, t, e, a) {
    var u = {
      lane: a,
      revertLane: 0,
      gesture: null,
      action: e,
      hasEagerState: !1,
      eagerState: null,
      next: null
    };
    if (gn(l)) Do(t, u);
    else {
      var n = l.alternate;
      if (l.lanes === 0 && (n === null || n.lanes === 0) && (n = t.lastRenderedReducer, n !== null))
        try {
          var i = t.lastRenderedState, c = n(i, e);
          if (u.hasEagerState = !0, u.eagerState = c, ct(c, i))
            return ku(l, t, u, 0), vl === null && Wu(), !1;
        } catch {
        }
      if (e = Ci(l, t, u, a), e !== null)
        return tt(e, l, a), Uo(e, t, a), !0;
    }
    return !1;
  }
  function gc(l, t, e, a) {
    if (a = {
      lane: 2,
      revertLane: Wc(),
      gesture: null,
      action: a,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, gn(l)) {
      if (t) throw Error(d(479));
    } else
      t = Ci(
        l,
        e,
        a,
        2
      ), t !== null && tt(t, l, 2);
  }
  function gn(l) {
    var t = l.alternate;
    return l === w || t !== null && t === w;
  }
  function Do(l, t) {
    ba = on = !0;
    var e = l.pending;
    e === null ? t.next = t : (t.next = e.next, e.next = t), l.pending = t;
  }
  function Uo(l, t, e) {
    if ((e & 4194048) !== 0) {
      var a = t.lanes;
      a &= l.pendingLanes, e |= a, t.lanes = e, qf(l, e);
    }
  }
  var fu = {
    readContext: Gl,
    use: mn,
    useCallback: pl,
    useContext: pl,
    useEffect: pl,
    useImperativeHandle: pl,
    useLayoutEffect: pl,
    useInsertionEffect: pl,
    useMemo: pl,
    useReducer: pl,
    useRef: pl,
    useState: pl,
    useDebugValue: pl,
    useDeferredValue: pl,
    useTransition: pl,
    useSyncExternalStore: pl,
    useId: pl,
    useHostTransitionStatus: pl,
    useFormState: pl,
    useActionState: pl,
    useOptimistic: pl,
    useMemoCache: pl,
    useCacheRefresh: pl
  };
  fu.useEffectEvent = pl;
  var Ro = {
    readContext: Gl,
    use: mn,
    useCallback: function(l, t) {
      return Vl().memoizedState = [
        l,
        t === void 0 ? null : t
      ], l;
    },
    useContext: Gl,
    useEffect: yo,
    useImperativeHandle: function(l, t, e) {
      e = e != null ? e.concat([l]) : null, vn(
        4194308,
        4,
        po.bind(null, t, l),
        e
      );
    },
    useLayoutEffect: function(l, t) {
      return vn(4194308, 4, l, t);
    },
    useInsertionEffect: function(l, t) {
      vn(4, 2, l, t);
    },
    useMemo: function(l, t) {
      var e = Vl();
      t = t === void 0 ? null : t;
      var a = l();
      if (Ze) {
        te(!0);
        try {
          l();
        } finally {
          te(!1);
        }
      }
      return e.memoizedState = [a, t], a;
    },
    useReducer: function(l, t, e) {
      var a = Vl();
      if (e !== void 0) {
        var u = e(t);
        if (Ze) {
          te(!0);
          try {
            e(t);
          } finally {
            te(!1);
          }
        }
      } else u = t;
      return a.memoizedState = a.baseState = u, l = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: l,
        lastRenderedState: u
      }, a.queue = l, l = l.dispatch = oh.bind(
        null,
        w,
        l
      ), [a.memoizedState, l];
    },
    useRef: function(l) {
      var t = Vl();
      return l = { current: l }, t.memoizedState = l;
    },
    useState: function(l) {
      l = oc(l);
      var t = l.queue, e = Mo.bind(null, w, t);
      return t.dispatch = e, [l.memoizedState, e];
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = Vl();
      return hc(e, l, t);
    },
    useTransition: function() {
      var l = oc(!1);
      return l = Eo.bind(
        null,
        w,
        l.queue,
        !0,
        !1
      ), Vl().memoizedState = l, [!1, l];
    },
    useSyncExternalStore: function(l, t, e) {
      var a = w, u = Vl();
      if (el) {
        if (e === void 0)
          throw Error(d(407));
        e = e();
      } else {
        if (e = t(), vl === null)
          throw Error(d(349));
        (P & 127) !== 0 || Ps(a, t, e);
      }
      u.memoizedState = e;
      var n = { value: e, getSnapshot: t };
      return u.queue = n, yo(to.bind(null, a, n, l), [
        l
      ]), a.flags |= 2048, Aa(
        9,
        { destroy: void 0 },
        lo.bind(
          null,
          a,
          n,
          e,
          t
        ),
        null
      ), e;
    },
    useId: function() {
      var l = Vl(), t = vl.identifierPrefix;
      if (el) {
        var e = Ut, a = Dt;
        e = (a & ~(1 << 32 - it(a) - 1)).toString(32) + e, t = "_" + t + "R_" + e, e = dn++, 0 < e && (t += "H" + e.toString(32)), t += "_";
      } else
        e = ah++, t = "_" + t + "r_" + e.toString(32) + "_";
      return l.memoizedState = t;
    },
    useHostTransitionStatus: yc,
    useFormState: oo,
    useActionState: oo,
    useOptimistic: function(l) {
      var t = Vl();
      t.memoizedState = t.baseState = l;
      var e = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: null,
        lastRenderedState: null
      };
      return t.queue = e, t = gc.bind(
        null,
        w,
        !0,
        e
      ), e.dispatch = t, [l, t];
    },
    useMemoCache: cc,
    useCacheRefresh: function() {
      return Vl().memoizedState = sh.bind(
        null,
        w
      );
    },
    useEffectEvent: function(l) {
      var t = Vl(), e = { impl: l };
      return t.memoizedState = e, function() {
        if ((nl & 2) !== 0)
          throw Error(d(440));
        return e.impl.apply(void 0, arguments);
      };
    }
  }, Sc = {
    readContext: Gl,
    use: mn,
    useCallback: zo,
    useContext: Gl,
    useEffect: rc,
    useImperativeHandle: Ao,
    useInsertionEffect: So,
    useLayoutEffect: bo,
    useMemo: To,
    useReducer: hn,
    useRef: vo,
    useState: function() {
      return hn(Vt);
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = jl();
      return jo(
        e,
        dl.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = hn(Vt)[0], t = jl().memoizedState;
      return [
        typeof l == "boolean" ? l : iu(l),
        t
      ];
    },
    useSyncExternalStore: Is,
    useId: Oo,
    useHostTransitionStatus: yc,
    useFormState: ro,
    useActionState: ro,
    useOptimistic: function(l, t) {
      var e = jl();
      return uo(e, dl, l, t);
    },
    useMemoCache: cc,
    useCacheRefresh: _o
  };
  Sc.useEffectEvent = go;
  var Co = {
    readContext: Gl,
    use: mn,
    useCallback: zo,
    useContext: Gl,
    useEffect: rc,
    useImperativeHandle: Ao,
    useInsertionEffect: So,
    useLayoutEffect: bo,
    useMemo: To,
    useReducer: sc,
    useRef: vo,
    useState: function() {
      return sc(Vt);
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = jl();
      return dl === null ? hc(e, l, t) : jo(
        e,
        dl.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = sc(Vt)[0], t = jl().memoizedState;
      return [
        typeof l == "boolean" ? l : iu(l),
        t
      ];
    },
    useSyncExternalStore: Is,
    useId: Oo,
    useHostTransitionStatus: yc,
    useFormState: ho,
    useActionState: ho,
    useOptimistic: function(l, t) {
      var e = jl();
      return dl !== null ? uo(e, dl, l, t) : (e.baseState = l, [l, e.queue.dispatch]);
    },
    useMemoCache: cc,
    useCacheRefresh: _o
  };
  Co.useEffectEvent = go;
  function bc(l, t, e, a) {
    t = l.memoizedState, e = e(a, t), e = e == null ? t : p({}, t, e), l.memoizedState = e, l.lanes === 0 && (l.updateQueue.baseState = e);
  }
  var pc = {
    enqueueSetState: function(l, t, e) {
      l = l._reactInternals;
      var a = mt(), u = se(a);
      u.payload = t, e != null && (u.callback = e), t = oe(l, u, a), t !== null && (tt(t, l, a), eu(t, l, a));
    },
    enqueueReplaceState: function(l, t, e) {
      l = l._reactInternals;
      var a = mt(), u = se(a);
      u.tag = 1, u.payload = t, e != null && (u.callback = e), t = oe(l, u, a), t !== null && (tt(t, l, a), eu(t, l, a));
    },
    enqueueForceUpdate: function(l, t) {
      l = l._reactInternals;
      var e = mt(), a = se(e);
      a.tag = 2, t != null && (a.callback = t), t = oe(l, a, e), t !== null && (tt(t, l, e), eu(t, l, e));
    }
  };
  function Ho(l, t, e, a, u, n, i) {
    return l = l.stateNode, typeof l.shouldComponentUpdate == "function" ? l.shouldComponentUpdate(a, n, i) : t.prototype && t.prototype.isPureReactComponent ? !$a(e, a) || !$a(u, n) : !0;
  }
  function qo(l, t, e, a) {
    l = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(e, a), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(e, a), t.state !== l && pc.enqueueReplaceState(t, t.state, null);
  }
  function Ve(l, t) {
    var e = t;
    if ("ref" in t) {
      e = {};
      for (var a in t)
        a !== "ref" && (e[a] = t[a]);
    }
    if (l = l.defaultProps) {
      e === t && (e = p({}, e));
      for (var u in l)
        e[u] === void 0 && (e[u] = l[u]);
    }
    return e;
  }
  function Bo(l) {
    $u(l);
  }
  function Yo(l) {
    console.error(l);
  }
  function Go(l) {
    $u(l);
  }
  function Sn(l, t) {
    try {
      var e = l.onUncaughtError;
      e(t.value, { componentStack: t.stack });
    } catch (a) {
      setTimeout(function() {
        throw a;
      });
    }
  }
  function Lo(l, t, e) {
    try {
      var a = l.onCaughtError;
      a(e.value, {
        componentStack: e.stack,
        errorBoundary: t.tag === 1 ? t.stateNode : null
      });
    } catch (u) {
      setTimeout(function() {
        throw u;
      });
    }
  }
  function Ac(l, t, e) {
    return e = se(e), e.tag = 3, e.payload = { element: null }, e.callback = function() {
      Sn(l, t);
    }, e;
  }
  function Xo(l) {
    return l = se(l), l.tag = 3, l;
  }
  function Qo(l, t, e, a) {
    var u = e.type.getDerivedStateFromError;
    if (typeof u == "function") {
      var n = a.value;
      l.payload = function() {
        return u(n);
      }, l.callback = function() {
        Lo(t, e, a);
      };
    }
    var i = e.stateNode;
    i !== null && typeof i.componentDidCatch == "function" && (l.callback = function() {
      Lo(t, e, a), typeof u != "function" && (ye === null ? ye = /* @__PURE__ */ new Set([this]) : ye.add(this));
      var c = a.stack;
      this.componentDidCatch(a.value, {
        componentStack: c !== null ? c : ""
      });
    });
  }
  function dh(l, t, e, a, u) {
    if (e.flags |= 32768, a !== null && typeof a == "object" && typeof a.then == "function") {
      if (t = e.alternate, t !== null && ma(
        t,
        e,
        u,
        !0
      ), e = st.current, e !== null) {
        switch (e.tag) {
          case 31:
          case 13:
            return zt === null ? Mn() : e.alternate === null && Al === 0 && (Al = 3), e.flags &= -257, e.flags |= 65536, e.lanes = u, a === un ? e.flags |= 16384 : (t = e.updateQueue, t === null ? e.updateQueue = /* @__PURE__ */ new Set([a]) : t.add(a), Jc(l, a, u)), !1;
          case 22:
            return e.flags |= 65536, a === un ? e.flags |= 16384 : (t = e.updateQueue, t === null ? (t = {
              transitions: null,
              markerInstances: null,
              retryQueue: /* @__PURE__ */ new Set([a])
            }, e.updateQueue = t) : (e = t.retryQueue, e === null ? t.retryQueue = /* @__PURE__ */ new Set([a]) : e.add(a)), Jc(l, a, u)), !1;
        }
        throw Error(d(435, e.tag));
      }
      return Jc(l, a, u), Mn(), !1;
    }
    if (el)
      return t = st.current, t !== null ? ((t.flags & 65536) === 0 && (t.flags |= 256), t.flags |= 65536, t.lanes = u, a !== Li && (l = Error(d(422), { cause: a }), Fa(St(l, e)))) : (a !== Li && (t = Error(d(423), {
        cause: a
      }), Fa(
        St(t, e)
      )), l = l.current.alternate, l.flags |= 65536, u &= -u, l.lanes |= u, a = St(a, e), u = Ac(
        l.stateNode,
        a,
        u
      ), Fi(l, u), Al !== 4 && (Al = 2)), !1;
    var n = Error(d(520), { cause: a });
    if (n = St(n, e), yu === null ? yu = [n] : yu.push(n), Al !== 4 && (Al = 2), t === null) return !0;
    a = St(a, e), e = t;
    do {
      switch (e.tag) {
        case 3:
          return e.flags |= 65536, l = u & -u, e.lanes |= l, l = Ac(e.stateNode, a, l), Fi(e, l), !1;
        case 1:
          if (t = e.type, n = e.stateNode, (e.flags & 128) === 0 && (typeof t.getDerivedStateFromError == "function" || n !== null && typeof n.componentDidCatch == "function" && (ye === null || !ye.has(n))))
            return e.flags |= 65536, u &= -u, e.lanes |= u, u = Xo(u), Qo(
              u,
              l,
              e,
              a
            ), Fi(e, u), !1;
      }
      e = e.return;
    } while (e !== null);
    return !1;
  }
  var zc = Error(d(461)), Ml = !1;
  function Ll(l, t, e, a) {
    t.child = l === null ? Ks(t, null, e, a) : Qe(
      t,
      l.child,
      e,
      a
    );
  }
  function Zo(l, t, e, a, u) {
    e = e.render;
    var n = t.ref;
    if ("ref" in a) {
      var i = {};
      for (var c in a)
        c !== "ref" && (i[c] = a[c]);
    } else i = a;
    return Ye(t), a = ac(
      l,
      t,
      e,
      i,
      n,
      u
    ), c = uc(), l !== null && !Ml ? (nc(l, t, u), Kt(l, t, u)) : (el && c && Yi(t), t.flags |= 1, Ll(l, t, a, u), t.child);
  }
  function Vo(l, t, e, a, u) {
    if (l === null) {
      var n = e.type;
      return typeof n == "function" && !Hi(n) && n.defaultProps === void 0 && e.compare === null ? (t.tag = 15, t.type = n, Ko(
        l,
        t,
        n,
        a,
        u
      )) : (l = Iu(
        e.type,
        null,
        a,
        t,
        t.mode,
        u
      ), l.ref = t.ref, l.return = t, t.child = l);
    }
    if (n = l.child, !Mc(l, u)) {
      var i = n.memoizedProps;
      if (e = e.compare, e = e !== null ? e : $a, e(i, a) && l.ref === t.ref)
        return Kt(l, t, u);
    }
    return t.flags |= 1, l = Gt(n, a), l.ref = t.ref, l.return = t, t.child = l;
  }
  function Ko(l, t, e, a, u) {
    if (l !== null) {
      var n = l.memoizedProps;
      if ($a(n, a) && l.ref === t.ref)
        if (Ml = !1, t.pendingProps = a = n, Mc(l, u))
          (l.flags & 131072) !== 0 && (Ml = !0);
        else
          return t.lanes = l.lanes, Kt(l, t, u);
    }
    return Tc(
      l,
      t,
      e,
      a,
      u
    );
  }
  function Jo(l, t, e, a) {
    var u = a.children, n = l !== null ? l.memoizedState : null;
    if (l === null && t.stateNode === null && (t.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), a.mode === "hidden") {
      if ((t.flags & 128) !== 0) {
        if (n = n !== null ? n.baseLanes | e : e, l !== null) {
          for (a = t.child = l.child, u = 0; a !== null; )
            u = u | a.lanes | a.childLanes, a = a.sibling;
          a = u & ~n;
        } else a = 0, t.child = null;
        return wo(
          l,
          t,
          n,
          e,
          a
        );
      }
      if ((e & 536870912) !== 0)
        t.memoizedState = { baseLanes: 0, cachePool: null }, l !== null && en(
          t,
          n !== null ? n.cachePool : null
        ), n !== null ? $s(t, n) : Pi(), Ws(t);
      else
        return a = t.lanes = 536870912, wo(
          l,
          t,
          n !== null ? n.baseLanes | e : e,
          e,
          a
        );
    } else
      n !== null ? (en(t, n.cachePool), $s(t, n), re(), t.memoizedState = null) : (l !== null && en(t, null), Pi(), re());
    return Ll(l, t, u, e), t.child;
  }
  function su(l, t) {
    return l !== null && l.tag === 22 || t.stateNode !== null || (t.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), t.sibling;
  }
  function wo(l, t, e, a, u) {
    var n = wi();
    return n = n === null ? null : { parent: Ol._currentValue, pool: n }, t.memoizedState = {
      baseLanes: e,
      cachePool: n
    }, l !== null && en(t, null), Pi(), Ws(t), l !== null && ma(l, t, a, !0), t.childLanes = u, null;
  }
  function bn(l, t) {
    return t = An(
      { mode: t.mode, children: t.children },
      l.mode
    ), t.ref = l.ref, l.child = t, t.return = l, t;
  }
  function $o(l, t, e) {
    return Qe(t, l.child, null, e), l = bn(t, t.pendingProps), l.flags |= 2, ot(t), t.memoizedState = null, l;
  }
  function rh(l, t, e) {
    var a = t.pendingProps, u = (t.flags & 128) !== 0;
    if (t.flags &= -129, l === null) {
      if (el) {
        if (a.mode === "hidden")
          return l = bn(t, a), t.lanes = 536870912, su(null, l);
        if (tc(t), (l = yl) ? (l = ir(
          l,
          At
        ), l = l !== null && l.data === "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ue !== null ? { id: Dt, overflow: Ut } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, e = Ms(l), e.return = t, t.child = e, Yl = t, yl = null)) : l = null, l === null) throw ie(t);
        return t.lanes = 536870912, null;
      }
      return bn(t, a);
    }
    var n = l.memoizedState;
    if (n !== null) {
      var i = n.dehydrated;
      if (tc(t), u)
        if (t.flags & 256)
          t.flags &= -257, t = $o(
            l,
            t,
            e
          );
        else if (t.memoizedState !== null)
          t.child = l.child, t.flags |= 128, t = null;
        else throw Error(d(558));
      else if (Ml || ma(l, t, e, !1), u = (e & l.childLanes) !== 0, Ml || u) {
        if (a = vl, a !== null && (i = Bf(a, e), i !== 0 && i !== n.retryLane))
          throw n.retryLane = i, Ce(l, i), tt(a, l, i), zc;
        Mn(), t = $o(
          l,
          t,
          e
        );
      } else
        l = n.treeContext, yl = Tt(i.nextSibling), Yl = t, el = !0, ne = null, At = !1, l !== null && Rs(t, l), t = bn(t, a), t.flags |= 4096;
      return t;
    }
    return l = Gt(l.child, {
      mode: a.mode,
      children: a.children
    }), l.ref = t.ref, t.child = l, l.return = t, l;
  }
  function pn(l, t) {
    var e = t.ref;
    if (e === null)
      l !== null && l.ref !== null && (t.flags |= 4194816);
    else {
      if (typeof e != "function" && typeof e != "object")
        throw Error(d(284));
      (l === null || l.ref !== e) && (t.flags |= 4194816);
    }
  }
  function Tc(l, t, e, a, u) {
    return Ye(t), e = ac(
      l,
      t,
      e,
      a,
      void 0,
      u
    ), a = uc(), l !== null && !Ml ? (nc(l, t, u), Kt(l, t, u)) : (el && a && Yi(t), t.flags |= 1, Ll(l, t, e, u), t.child);
  }
  function Wo(l, t, e, a, u, n) {
    return Ye(t), t.updateQueue = null, e = Fs(
      t,
      a,
      e,
      u
    ), ks(l), a = uc(), l !== null && !Ml ? (nc(l, t, n), Kt(l, t, n)) : (el && a && Yi(t), t.flags |= 1, Ll(l, t, e, n), t.child);
  }
  function ko(l, t, e, a, u) {
    if (Ye(t), t.stateNode === null) {
      var n = sa, i = e.contextType;
      typeof i == "object" && i !== null && (n = Gl(i)), n = new e(a, n), t.memoizedState = n.state !== null && n.state !== void 0 ? n.state : null, n.updater = pc, t.stateNode = n, n._reactInternals = t, n = t.stateNode, n.props = a, n.state = t.memoizedState, n.refs = {}, Wi(t), i = e.contextType, n.context = typeof i == "object" && i !== null ? Gl(i) : sa, n.state = t.memoizedState, i = e.getDerivedStateFromProps, typeof i == "function" && (bc(
        t,
        e,
        i,
        a
      ), n.state = t.memoizedState), typeof e.getDerivedStateFromProps == "function" || typeof n.getSnapshotBeforeUpdate == "function" || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (i = n.state, typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount(), i !== n.state && pc.enqueueReplaceState(n, n.state, null), uu(t, a, n, u), au(), n.state = t.memoizedState), typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !0;
    } else if (l === null) {
      n = t.stateNode;
      var c = t.memoizedProps, s = Ve(e, c);
      n.props = s;
      var y = n.context, b = e.contextType;
      i = sa, typeof b == "object" && b !== null && (i = Gl(b));
      var j = e.getDerivedStateFromProps;
      b = typeof j == "function" || typeof n.getSnapshotBeforeUpdate == "function", c = t.pendingProps !== c, b || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (c || y !== i) && qo(
        t,
        n,
        a,
        i
      ), fe = !1;
      var g = t.memoizedState;
      n.state = g, uu(t, a, n, u), au(), y = t.memoizedState, c || g !== y || fe ? (typeof j == "function" && (bc(
        t,
        e,
        j,
        a
      ), y = t.memoizedState), (s = fe || Ho(
        t,
        e,
        s,
        a,
        g,
        y,
        i
      )) ? (b || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount()), typeof n.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = a, t.memoizedState = y), n.props = a, n.state = y, n.context = i, a = s) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !1);
    } else {
      n = t.stateNode, ki(l, t), i = t.memoizedProps, b = Ve(e, i), n.props = b, j = t.pendingProps, g = n.context, y = e.contextType, s = sa, typeof y == "object" && y !== null && (s = Gl(y)), c = e.getDerivedStateFromProps, (y = typeof c == "function" || typeof n.getSnapshotBeforeUpdate == "function") || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (i !== j || g !== s) && qo(
        t,
        n,
        a,
        s
      ), fe = !1, g = t.memoizedState, n.state = g, uu(t, a, n, u), au();
      var S = t.memoizedState;
      i !== j || g !== S || fe || l !== null && l.dependencies !== null && ln(l.dependencies) ? (typeof c == "function" && (bc(
        t,
        e,
        c,
        a
      ), S = t.memoizedState), (b = fe || Ho(
        t,
        e,
        b,
        a,
        g,
        S,
        s
      ) || l !== null && l.dependencies !== null && ln(l.dependencies)) ? (y || typeof n.UNSAFE_componentWillUpdate != "function" && typeof n.componentWillUpdate != "function" || (typeof n.componentWillUpdate == "function" && n.componentWillUpdate(a, S, s), typeof n.UNSAFE_componentWillUpdate == "function" && n.UNSAFE_componentWillUpdate(
        a,
        S,
        s
      )), typeof n.componentDidUpdate == "function" && (t.flags |= 4), typeof n.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), t.memoizedProps = a, t.memoizedState = S), n.props = a, n.state = S, n.context = s, a = b) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), a = !1);
    }
    return n = a, pn(l, t), a = (t.flags & 128) !== 0, n || a ? (n = t.stateNode, e = a && typeof e.getDerivedStateFromError != "function" ? null : n.render(), t.flags |= 1, l !== null && a ? (t.child = Qe(
      t,
      l.child,
      null,
      u
    ), t.child = Qe(
      t,
      null,
      e,
      u
    )) : Ll(l, t, e, u), t.memoizedState = n.state, l = t.child) : l = Kt(
      l,
      t,
      u
    ), l;
  }
  function Fo(l, t, e, a) {
    return qe(), t.flags |= 256, Ll(l, t, e, a), t.child;
  }
  var jc = {
    dehydrated: null,
    treeContext: null,
    retryLane: 0,
    hydrationErrors: null
  };
  function Ec(l) {
    return { baseLanes: l, cachePool: Gs() };
  }
  function xc(l, t, e) {
    return l = l !== null ? l.childLanes & ~e : 0, t && (l |= rt), l;
  }
  function Io(l, t, e) {
    var a = t.pendingProps, u = !1, n = (t.flags & 128) !== 0, i;
    if ((i = n) || (i = l !== null && l.memoizedState === null ? !1 : (Tl.current & 2) !== 0), i && (u = !0, t.flags &= -129), i = (t.flags & 32) !== 0, t.flags &= -33, l === null) {
      if (el) {
        if (u ? de(t) : re(), (l = yl) ? (l = ir(
          l,
          At
        ), l = l !== null && l.data !== "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ue !== null ? { id: Dt, overflow: Ut } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, e = Ms(l), e.return = t, t.child = e, Yl = t, yl = null)) : l = null, l === null) throw ie(t);
        return sf(l) ? t.lanes = 32 : t.lanes = 536870912, null;
      }
      var c = a.children;
      return a = a.fallback, u ? (re(), u = t.mode, c = An(
        { mode: "hidden", children: c },
        u
      ), a = He(
        a,
        u,
        e,
        null
      ), c.return = t, a.return = t, c.sibling = a, t.child = c, a = t.child, a.memoizedState = Ec(e), a.childLanes = xc(
        l,
        i,
        e
      ), t.memoizedState = jc, su(null, a)) : (de(t), Nc(t, c));
    }
    var s = l.memoizedState;
    if (s !== null && (c = s.dehydrated, c !== null)) {
      if (n)
        t.flags & 256 ? (de(t), t.flags &= -257, t = Oc(
          l,
          t,
          e
        )) : t.memoizedState !== null ? (re(), t.child = l.child, t.flags |= 128, t = null) : (re(), c = a.fallback, u = t.mode, a = An(
          { mode: "visible", children: a.children },
          u
        ), c = He(
          c,
          u,
          e,
          null
        ), c.flags |= 2, a.return = t, c.return = t, a.sibling = c, t.child = a, Qe(
          t,
          l.child,
          null,
          e
        ), a = t.child, a.memoizedState = Ec(e), a.childLanes = xc(
          l,
          i,
          e
        ), t.memoizedState = jc, t = su(null, a));
      else if (de(t), sf(c)) {
        if (i = c.nextSibling && c.nextSibling.dataset, i) var y = i.dgst;
        i = y, a = Error(d(419)), a.stack = "", a.digest = i, Fa({ value: a, source: null, stack: null }), t = Oc(
          l,
          t,
          e
        );
      } else if (Ml || ma(l, t, e, !1), i = (e & l.childLanes) !== 0, Ml || i) {
        if (i = vl, i !== null && (a = Bf(i, e), a !== 0 && a !== s.retryLane))
          throw s.retryLane = a, Ce(l, a), tt(i, l, a), zc;
        ff(c) || Mn(), t = Oc(
          l,
          t,
          e
        );
      } else
        ff(c) ? (t.flags |= 192, t.child = l.child, t = null) : (l = s.treeContext, yl = Tt(
          c.nextSibling
        ), Yl = t, el = !0, ne = null, At = !1, l !== null && Rs(t, l), t = Nc(
          t,
          a.children
        ), t.flags |= 4096);
      return t;
    }
    return u ? (re(), c = a.fallback, u = t.mode, s = l.child, y = s.sibling, a = Gt(s, {
      mode: "hidden",
      children: a.children
    }), a.subtreeFlags = s.subtreeFlags & 65011712, y !== null ? c = Gt(
      y,
      c
    ) : (c = He(
      c,
      u,
      e,
      null
    ), c.flags |= 2), c.return = t, a.return = t, a.sibling = c, t.child = a, su(null, a), a = t.child, c = l.child.memoizedState, c === null ? c = Ec(e) : (u = c.cachePool, u !== null ? (s = Ol._currentValue, u = u.parent !== s ? { parent: s, pool: s } : u) : u = Gs(), c = {
      baseLanes: c.baseLanes | e,
      cachePool: u
    }), a.memoizedState = c, a.childLanes = xc(
      l,
      i,
      e
    ), t.memoizedState = jc, su(l.child, a)) : (de(t), e = l.child, l = e.sibling, e = Gt(e, {
      mode: "visible",
      children: a.children
    }), e.return = t, e.sibling = null, l !== null && (i = t.deletions, i === null ? (t.deletions = [l], t.flags |= 16) : i.push(l)), t.child = e, t.memoizedState = null, e);
  }
  function Nc(l, t) {
    return t = An(
      { mode: "visible", children: t },
      l.mode
    ), t.return = l, l.child = t;
  }
  function An(l, t) {
    return l = ft(22, l, null, t), l.lanes = 0, l;
  }
  function Oc(l, t, e) {
    return Qe(t, l.child, null, e), l = Nc(
      t,
      t.pendingProps.children
    ), l.flags |= 2, t.memoizedState = null, l;
  }
  function Po(l, t, e) {
    l.lanes |= t;
    var a = l.alternate;
    a !== null && (a.lanes |= t), Zi(l.return, t, e);
  }
  function _c(l, t, e, a, u, n) {
    var i = l.memoizedState;
    i === null ? l.memoizedState = {
      isBackwards: t,
      rendering: null,
      renderingStartTime: 0,
      last: a,
      tail: e,
      tailMode: u,
      treeForkCount: n
    } : (i.isBackwards = t, i.rendering = null, i.renderingStartTime = 0, i.last = a, i.tail = e, i.tailMode = u, i.treeForkCount = n);
  }
  function ld(l, t, e) {
    var a = t.pendingProps, u = a.revealOrder, n = a.tail;
    a = a.children;
    var i = Tl.current, c = (i & 2) !== 0;
    if (c ? (i = i & 1 | 2, t.flags |= 128) : i &= 1, R(Tl, i), Ll(l, t, a, e), a = el ? ka : 0, !c && l !== null && (l.flags & 128) !== 0)
      l: for (l = t.child; l !== null; ) {
        if (l.tag === 13)
          l.memoizedState !== null && Po(l, e, t);
        else if (l.tag === 19)
          Po(l, e, t);
        else if (l.child !== null) {
          l.child.return = l, l = l.child;
          continue;
        }
        if (l === t) break l;
        for (; l.sibling === null; ) {
          if (l.return === null || l.return === t)
            break l;
          l = l.return;
        }
        l.sibling.return = l.return, l = l.sibling;
      }
    switch (u) {
      case "forwards":
        for (e = t.child, u = null; e !== null; )
          l = e.alternate, l !== null && sn(l) === null && (u = e), e = e.sibling;
        e = u, e === null ? (u = t.child, t.child = null) : (u = e.sibling, e.sibling = null), _c(
          t,
          !1,
          u,
          e,
          n,
          a
        );
        break;
      case "backwards":
      case "unstable_legacy-backwards":
        for (e = null, u = t.child, t.child = null; u !== null; ) {
          if (l = u.alternate, l !== null && sn(l) === null) {
            t.child = u;
            break;
          }
          l = u.sibling, u.sibling = e, e = u, u = l;
        }
        _c(
          t,
          !0,
          e,
          null,
          n,
          a
        );
        break;
      case "together":
        _c(
          t,
          !1,
          null,
          null,
          void 0,
          a
        );
        break;
      default:
        t.memoizedState = null;
    }
    return t.child;
  }
  function Kt(l, t, e) {
    if (l !== null && (t.dependencies = l.dependencies), ve |= t.lanes, (e & t.childLanes) === 0)
      if (l !== null) {
        if (ma(
          l,
          t,
          e,
          !1
        ), (e & t.childLanes) === 0)
          return null;
      } else return null;
    if (l !== null && t.child !== l.child)
      throw Error(d(153));
    if (t.child !== null) {
      for (l = t.child, e = Gt(l, l.pendingProps), t.child = e, e.return = t; l.sibling !== null; )
        l = l.sibling, e = e.sibling = Gt(l, l.pendingProps), e.return = t;
      e.sibling = null;
    }
    return t.child;
  }
  function Mc(l, t) {
    return (l.lanes & t) !== 0 ? !0 : (l = l.dependencies, !!(l !== null && ln(l)));
  }
  function mh(l, t, e) {
    switch (t.tag) {
      case 3:
        Zl(t, t.stateNode.containerInfo), ce(t, Ol, l.memoizedState.cache), qe();
        break;
      case 27:
      case 5:
        Ha(t);
        break;
      case 4:
        Zl(t, t.stateNode.containerInfo);
        break;
      case 10:
        ce(
          t,
          t.type,
          t.memoizedProps.value
        );
        break;
      case 31:
        if (t.memoizedState !== null)
          return t.flags |= 128, tc(t), null;
        break;
      case 13:
        var a = t.memoizedState;
        if (a !== null)
          return a.dehydrated !== null ? (de(t), t.flags |= 128, null) : (e & t.child.childLanes) !== 0 ? Io(l, t, e) : (de(t), l = Kt(
            l,
            t,
            e
          ), l !== null ? l.sibling : null);
        de(t);
        break;
      case 19:
        var u = (l.flags & 128) !== 0;
        if (a = (e & t.childLanes) !== 0, a || (ma(
          l,
          t,
          e,
          !1
        ), a = (e & t.childLanes) !== 0), u) {
          if (a)
            return ld(
              l,
              t,
              e
            );
          t.flags |= 128;
        }
        if (u = t.memoizedState, u !== null && (u.rendering = null, u.tail = null, u.lastEffect = null), R(Tl, Tl.current), a) break;
        return null;
      case 22:
        return t.lanes = 0, Jo(
          l,
          t,
          e,
          t.pendingProps
        );
      case 24:
        ce(t, Ol, l.memoizedState.cache);
    }
    return Kt(l, t, e);
  }
  function td(l, t, e) {
    if (l !== null)
      if (l.memoizedProps !== t.pendingProps)
        Ml = !0;
      else {
        if (!Mc(l, e) && (t.flags & 128) === 0)
          return Ml = !1, mh(
            l,
            t,
            e
          );
        Ml = (l.flags & 131072) !== 0;
      }
    else
      Ml = !1, el && (t.flags & 1048576) !== 0 && Us(t, ka, t.index);
    switch (t.lanes = 0, t.tag) {
      case 16:
        l: {
          var a = t.pendingProps;
          if (l = Le(t.elementType), t.type = l, typeof l == "function")
            Hi(l) ? (a = Ve(l, a), t.tag = 1, t = ko(
              null,
              t,
              l,
              a,
              e
            )) : (t.tag = 0, t = Tc(
              null,
              t,
              l,
              a,
              e
            ));
          else {
            if (l != null) {
              var u = l.$$typeof;
              if (u === Jl) {
                t.tag = 11, t = Zo(
                  null,
                  t,
                  l,
                  a,
                  e
                );
                break l;
              } else if (u === $) {
                t.tag = 14, t = Vo(
                  null,
                  t,
                  l,
                  a,
                  e
                );
                break l;
              }
            }
            throw t = Ht(l) || l, Error(d(306, t, ""));
          }
        }
        return t;
      case 0:
        return Tc(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 1:
        return a = t.type, u = Ve(
          a,
          t.pendingProps
        ), ko(
          l,
          t,
          a,
          u,
          e
        );
      case 3:
        l: {
          if (Zl(
            t,
            t.stateNode.containerInfo
          ), l === null) throw Error(d(387));
          a = t.pendingProps;
          var n = t.memoizedState;
          u = n.element, ki(l, t), uu(t, a, null, e);
          var i = t.memoizedState;
          if (a = i.cache, ce(t, Ol, a), a !== n.cache && Vi(
            t,
            [Ol],
            e,
            !0
          ), au(), a = i.element, n.isDehydrated)
            if (n = {
              element: a,
              isDehydrated: !1,
              cache: i.cache
            }, t.updateQueue.baseState = n, t.memoizedState = n, t.flags & 256) {
              t = Fo(
                l,
                t,
                a,
                e
              );
              break l;
            } else if (a !== u) {
              u = St(
                Error(d(424)),
                t
              ), Fa(u), t = Fo(
                l,
                t,
                a,
                e
              );
              break l;
            } else
              for (l = t.stateNode.containerInfo, l.nodeType === 9 ? l = l.body : l = l.nodeName === "HTML" ? l.ownerDocument.body : l, yl = Tt(l.firstChild), Yl = t, el = !0, ne = null, At = !0, e = Ks(
                t,
                null,
                a,
                e
              ), t.child = e; e; )
                e.flags = e.flags & -3 | 4096, e = e.sibling;
          else {
            if (qe(), a === u) {
              t = Kt(
                l,
                t,
                e
              );
              break l;
            }
            Ll(l, t, a, e);
          }
          t = t.child;
        }
        return t;
      case 26:
        return pn(l, t), l === null ? (e = rr(
          t.type,
          null,
          t.pendingProps,
          null
        )) ? t.memoizedState = e : el || (e = t.type, l = t.pendingProps, a = Bn(
          k.current
        ).createElement(e), a[Bl] = t, a[Wl] = l, Xl(a, e, l), Hl(a), t.stateNode = a) : t.memoizedState = rr(
          t.type,
          l.memoizedProps,
          t.pendingProps,
          l.memoizedState
        ), null;
      case 27:
        return Ha(t), l === null && el && (a = t.stateNode = sr(
          t.type,
          t.pendingProps,
          k.current
        ), Yl = t, At = !0, u = yl, pe(t.type) ? (of = u, yl = Tt(a.firstChild)) : yl = u), Ll(
          l,
          t,
          t.pendingProps.children,
          e
        ), pn(l, t), l === null && (t.flags |= 4194304), t.child;
      case 5:
        return l === null && el && ((u = a = yl) && (a = Zh(
          a,
          t.type,
          t.pendingProps,
          At
        ), a !== null ? (t.stateNode = a, Yl = t, yl = Tt(a.firstChild), At = !1, u = !0) : u = !1), u || ie(t)), Ha(t), u = t.type, n = t.pendingProps, i = l !== null ? l.memoizedProps : null, a = n.children, uf(u, n) ? a = null : i !== null && uf(u, i) && (t.flags |= 32), t.memoizedState !== null && (u = ac(
          l,
          t,
          uh,
          null,
          null,
          e
        ), ju._currentValue = u), pn(l, t), Ll(l, t, a, e), t.child;
      case 6:
        return l === null && el && ((l = e = yl) && (e = Vh(
          e,
          t.pendingProps,
          At
        ), e !== null ? (t.stateNode = e, Yl = t, yl = null, l = !0) : l = !1), l || ie(t)), null;
      case 13:
        return Io(l, t, e);
      case 4:
        return Zl(
          t,
          t.stateNode.containerInfo
        ), a = t.pendingProps, l === null ? t.child = Qe(
          t,
          null,
          a,
          e
        ) : Ll(l, t, a, e), t.child;
      case 11:
        return Zo(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 7:
        return Ll(
          l,
          t,
          t.pendingProps,
          e
        ), t.child;
      case 8:
        return Ll(
          l,
          t,
          t.pendingProps.children,
          e
        ), t.child;
      case 12:
        return Ll(
          l,
          t,
          t.pendingProps.children,
          e
        ), t.child;
      case 10:
        return a = t.pendingProps, ce(t, t.type, a.value), Ll(l, t, a.children, e), t.child;
      case 9:
        return u = t.type._context, a = t.pendingProps.children, Ye(t), u = Gl(u), a = a(u), t.flags |= 1, Ll(l, t, a, e), t.child;
      case 14:
        return Vo(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 15:
        return Ko(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 19:
        return ld(l, t, e);
      case 31:
        return rh(l, t, e);
      case 22:
        return Jo(
          l,
          t,
          e,
          t.pendingProps
        );
      case 24:
        return Ye(t), a = Gl(Ol), l === null ? (u = wi(), u === null && (u = vl, n = Ki(), u.pooledCache = n, n.refCount++, n !== null && (u.pooledCacheLanes |= e), u = n), t.memoizedState = { parent: a, cache: u }, Wi(t), ce(t, Ol, u)) : ((l.lanes & e) !== 0 && (ki(l, t), uu(t, null, null, e), au()), u = l.memoizedState, n = t.memoizedState, u.parent !== a ? (u = { parent: a, cache: a }, t.memoizedState = u, t.lanes === 0 && (t.memoizedState = t.updateQueue.baseState = u), ce(t, Ol, a)) : (a = n.cache, ce(t, Ol, a), a !== u.cache && Vi(
          t,
          [Ol],
          e,
          !0
        ))), Ll(
          l,
          t,
          t.pendingProps.children,
          e
        ), t.child;
      case 29:
        throw t.pendingProps;
    }
    throw Error(d(156, t.tag));
  }
  function Jt(l) {
    l.flags |= 4;
  }
  function Dc(l, t, e, a, u) {
    if ((t = (l.mode & 32) !== 0) && (t = !1), t) {
      if (l.flags |= 16777216, (u & 335544128) === u)
        if (l.stateNode.complete) l.flags |= 8192;
        else if (Od()) l.flags |= 8192;
        else
          throw Xe = un, $i;
    } else l.flags &= -16777217;
  }
  function ed(l, t) {
    if (t.type !== "stylesheet" || (t.state.loading & 4) !== 0)
      l.flags &= -16777217;
    else if (l.flags |= 16777216, !gr(t))
      if (Od()) l.flags |= 8192;
      else
        throw Xe = un, $i;
  }
  function zn(l, t) {
    t !== null && (l.flags |= 4), l.flags & 16384 && (t = l.tag !== 22 ? Cf() : 536870912, l.lanes |= t, Ea |= t);
  }
  function ou(l, t) {
    if (!el)
      switch (l.tailMode) {
        case "hidden":
          t = l.tail;
          for (var e = null; t !== null; )
            t.alternate !== null && (e = t), t = t.sibling;
          e === null ? l.tail = null : e.sibling = null;
          break;
        case "collapsed":
          e = l.tail;
          for (var a = null; e !== null; )
            e.alternate !== null && (a = e), e = e.sibling;
          a === null ? t || l.tail === null ? l.tail = null : l.tail.sibling = null : a.sibling = null;
      }
  }
  function gl(l) {
    var t = l.alternate !== null && l.alternate.child === l.child, e = 0, a = 0;
    if (t)
      for (var u = l.child; u !== null; )
        e |= u.lanes | u.childLanes, a |= u.subtreeFlags & 65011712, a |= u.flags & 65011712, u.return = l, u = u.sibling;
    else
      for (u = l.child; u !== null; )
        e |= u.lanes | u.childLanes, a |= u.subtreeFlags, a |= u.flags, u.return = l, u = u.sibling;
    return l.subtreeFlags |= a, l.childLanes = e, t;
  }
  function hh(l, t, e) {
    var a = t.pendingProps;
    switch (Gi(t), t.tag) {
      case 16:
      case 15:
      case 0:
      case 11:
      case 7:
      case 8:
      case 12:
      case 9:
      case 14:
        return gl(t), null;
      case 1:
        return gl(t), null;
      case 3:
        return e = t.stateNode, a = null, l !== null && (a = l.memoizedState.cache), t.memoizedState.cache !== a && (t.flags |= 2048), Qt(Ol), zl(), e.pendingContext && (e.context = e.pendingContext, e.pendingContext = null), (l === null || l.child === null) && (ra(t) ? Jt(t) : l === null || l.memoizedState.isDehydrated && (t.flags & 256) === 0 || (t.flags |= 1024, Xi())), gl(t), null;
      case 26:
        var u = t.type, n = t.memoizedState;
        return l === null ? (Jt(t), n !== null ? (gl(t), ed(t, n)) : (gl(t), Dc(
          t,
          u,
          null,
          a,
          e
        ))) : n ? n !== l.memoizedState ? (Jt(t), gl(t), ed(t, n)) : (gl(t), t.flags &= -16777217) : (l = l.memoizedProps, l !== a && Jt(t), gl(t), Dc(
          t,
          u,
          l,
          a,
          e
        )), null;
      case 27:
        if (Uu(t), e = k.current, u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Jt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(d(166));
            return gl(t), null;
          }
          l = q.current, ra(t) ? Cs(t) : (l = sr(u, a, e), t.stateNode = l, Jt(t));
        }
        return gl(t), null;
      case 5:
        if (Uu(t), u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Jt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(d(166));
            return gl(t), null;
          }
          if (n = q.current, ra(t))
            Cs(t);
          else {
            var i = Bn(
              k.current
            );
            switch (n) {
              case 1:
                n = i.createElementNS(
                  "http://www.w3.org/2000/svg",
                  u
                );
                break;
              case 2:
                n = i.createElementNS(
                  "http://www.w3.org/1998/Math/MathML",
                  u
                );
                break;
              default:
                switch (u) {
                  case "svg":
                    n = i.createElementNS(
                      "http://www.w3.org/2000/svg",
                      u
                    );
                    break;
                  case "math":
                    n = i.createElementNS(
                      "http://www.w3.org/1998/Math/MathML",
                      u
                    );
                    break;
                  case "script":
                    n = i.createElement("div"), n.innerHTML = "<script><\/script>", n = n.removeChild(
                      n.firstChild
                    );
                    break;
                  case "select":
                    n = typeof a.is == "string" ? i.createElement("select", {
                      is: a.is
                    }) : i.createElement("select"), a.multiple ? n.multiple = !0 : a.size && (n.size = a.size);
                    break;
                  default:
                    n = typeof a.is == "string" ? i.createElement(u, { is: a.is }) : i.createElement(u);
                }
            }
            n[Bl] = t, n[Wl] = a;
            l: for (i = t.child; i !== null; ) {
              if (i.tag === 5 || i.tag === 6)
                n.appendChild(i.stateNode);
              else if (i.tag !== 4 && i.tag !== 27 && i.child !== null) {
                i.child.return = i, i = i.child;
                continue;
              }
              if (i === t) break l;
              for (; i.sibling === null; ) {
                if (i.return === null || i.return === t)
                  break l;
                i = i.return;
              }
              i.sibling.return = i.return, i = i.sibling;
            }
            t.stateNode = n;
            l: switch (Xl(n, u, a), u) {
              case "button":
              case "input":
              case "select":
              case "textarea":
                a = !!a.autoFocus;
                break l;
              case "img":
                a = !0;
                break l;
              default:
                a = !1;
            }
            a && Jt(t);
          }
        }
        return gl(t), Dc(
          t,
          t.type,
          l === null ? null : l.memoizedProps,
          t.pendingProps,
          e
        ), null;
      case 6:
        if (l && t.stateNode != null)
          l.memoizedProps !== a && Jt(t);
        else {
          if (typeof a != "string" && t.stateNode === null)
            throw Error(d(166));
          if (l = k.current, ra(t)) {
            if (l = t.stateNode, e = t.memoizedProps, a = null, u = Yl, u !== null)
              switch (u.tag) {
                case 27:
                case 5:
                  a = u.memoizedProps;
              }
            l[Bl] = t, l = !!(l.nodeValue === e || a !== null && a.suppressHydrationWarning === !0 || Id(l.nodeValue, e)), l || ie(t, !0);
          } else
            l = Bn(l).createTextNode(
              a
            ), l[Bl] = t, t.stateNode = l;
        }
        return gl(t), null;
      case 31:
        if (e = t.memoizedState, l === null || l.memoizedState !== null) {
          if (a = ra(t), e !== null) {
            if (l === null) {
              if (!a) throw Error(d(318));
              if (l = t.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(d(557));
              l[Bl] = t;
            } else
              qe(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            gl(t), l = !1;
          } else
            e = Xi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = e), l = !0;
          if (!l)
            return t.flags & 256 ? (ot(t), t) : (ot(t), null);
          if ((t.flags & 128) !== 0)
            throw Error(d(558));
        }
        return gl(t), null;
      case 13:
        if (a = t.memoizedState, l === null || l.memoizedState !== null && l.memoizedState.dehydrated !== null) {
          if (u = ra(t), a !== null && a.dehydrated !== null) {
            if (l === null) {
              if (!u) throw Error(d(318));
              if (u = t.memoizedState, u = u !== null ? u.dehydrated : null, !u) throw Error(d(317));
              u[Bl] = t;
            } else
              qe(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            gl(t), u = !1;
          } else
            u = Xi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = u), u = !0;
          if (!u)
            return t.flags & 256 ? (ot(t), t) : (ot(t), null);
        }
        return ot(t), (t.flags & 128) !== 0 ? (t.lanes = e, t) : (e = a !== null, l = l !== null && l.memoizedState !== null, e && (a = t.child, u = null, a.alternate !== null && a.alternate.memoizedState !== null && a.alternate.memoizedState.cachePool !== null && (u = a.alternate.memoizedState.cachePool.pool), n = null, a.memoizedState !== null && a.memoizedState.cachePool !== null && (n = a.memoizedState.cachePool.pool), n !== u && (a.flags |= 2048)), e !== l && e && (t.child.flags |= 8192), zn(t, t.updateQueue), gl(t), null);
      case 4:
        return zl(), l === null && Pc(t.stateNode.containerInfo), gl(t), null;
      case 10:
        return Qt(t.type), gl(t), null;
      case 19:
        if (E(Tl), a = t.memoizedState, a === null) return gl(t), null;
        if (u = (t.flags & 128) !== 0, n = a.rendering, n === null)
          if (u) ou(a, !1);
          else {
            if (Al !== 0 || l !== null && (l.flags & 128) !== 0)
              for (l = t.child; l !== null; ) {
                if (n = sn(l), n !== null) {
                  for (t.flags |= 128, ou(a, !1), l = n.updateQueue, t.updateQueue = l, zn(t, l), t.subtreeFlags = 0, l = e, e = t.child; e !== null; )
                    _s(e, l), e = e.sibling;
                  return R(
                    Tl,
                    Tl.current & 1 | 2
                  ), el && Lt(t, a.treeForkCount), t.child;
                }
                l = l.sibling;
              }
            a.tail !== null && ut() > Nn && (t.flags |= 128, u = !0, ou(a, !1), t.lanes = 4194304);
          }
        else {
          if (!u)
            if (l = sn(n), l !== null) {
              if (t.flags |= 128, u = !0, l = l.updateQueue, t.updateQueue = l, zn(t, l), ou(a, !0), a.tail === null && a.tailMode === "hidden" && !n.alternate && !el)
                return gl(t), null;
            } else
              2 * ut() - a.renderingStartTime > Nn && e !== 536870912 && (t.flags |= 128, u = !0, ou(a, !1), t.lanes = 4194304);
          a.isBackwards ? (n.sibling = t.child, t.child = n) : (l = a.last, l !== null ? l.sibling = n : t.child = n, a.last = n);
        }
        return a.tail !== null ? (l = a.tail, a.rendering = l, a.tail = l.sibling, a.renderingStartTime = ut(), l.sibling = null, e = Tl.current, R(
          Tl,
          u ? e & 1 | 2 : e & 1
        ), el && Lt(t, a.treeForkCount), l) : (gl(t), null);
      case 22:
      case 23:
        return ot(t), lc(), a = t.memoizedState !== null, l !== null ? l.memoizedState !== null !== a && (t.flags |= 8192) : a && (t.flags |= 8192), a ? (e & 536870912) !== 0 && (t.flags & 128) === 0 && (gl(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : gl(t), e = t.updateQueue, e !== null && zn(t, e.retryQueue), e = null, l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (e = l.memoizedState.cachePool.pool), a = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (a = t.memoizedState.cachePool.pool), a !== e && (t.flags |= 2048), l !== null && E(Ge), null;
      case 24:
        return e = null, l !== null && (e = l.memoizedState.cache), t.memoizedState.cache !== e && (t.flags |= 2048), Qt(Ol), gl(t), null;
      case 25:
        return null;
      case 30:
        return null;
    }
    throw Error(d(156, t.tag));
  }
  function vh(l, t) {
    switch (Gi(t), t.tag) {
      case 1:
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 3:
        return Qt(Ol), zl(), l = t.flags, (l & 65536) !== 0 && (l & 128) === 0 ? (t.flags = l & -65537 | 128, t) : null;
      case 26:
      case 27:
      case 5:
        return Uu(t), null;
      case 31:
        if (t.memoizedState !== null) {
          if (ot(t), t.alternate === null)
            throw Error(d(340));
          qe();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 13:
        if (ot(t), l = t.memoizedState, l !== null && l.dehydrated !== null) {
          if (t.alternate === null)
            throw Error(d(340));
          qe();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 19:
        return E(Tl), null;
      case 4:
        return zl(), null;
      case 10:
        return Qt(t.type), null;
      case 22:
      case 23:
        return ot(t), lc(), l !== null && E(Ge), l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 24:
        return Qt(Ol), null;
      case 25:
        return null;
      default:
        return null;
    }
  }
  function ad(l, t) {
    switch (Gi(t), t.tag) {
      case 3:
        Qt(Ol), zl();
        break;
      case 26:
      case 27:
      case 5:
        Uu(t);
        break;
      case 4:
        zl();
        break;
      case 31:
        t.memoizedState !== null && ot(t);
        break;
      case 13:
        ot(t);
        break;
      case 19:
        E(Tl);
        break;
      case 10:
        Qt(t.type);
        break;
      case 22:
      case 23:
        ot(t), lc(), l !== null && E(Ge);
        break;
      case 24:
        Qt(Ol);
    }
  }
  function du(l, t) {
    try {
      var e = t.updateQueue, a = e !== null ? e.lastEffect : null;
      if (a !== null) {
        var u = a.next;
        e = u;
        do {
          if ((e.tag & l) === l) {
            a = void 0;
            var n = e.create, i = e.inst;
            a = n(), i.destroy = a;
          }
          e = e.next;
        } while (e !== u);
      }
    } catch (c) {
      sl(t, t.return, c);
    }
  }
  function me(l, t, e) {
    try {
      var a = t.updateQueue, u = a !== null ? a.lastEffect : null;
      if (u !== null) {
        var n = u.next;
        a = n;
        do {
          if ((a.tag & l) === l) {
            var i = a.inst, c = i.destroy;
            if (c !== void 0) {
              i.destroy = void 0, u = t;
              var s = e, y = c;
              try {
                y();
              } catch (b) {
                sl(
                  u,
                  s,
                  b
                );
              }
            }
          }
          a = a.next;
        } while (a !== n);
      }
    } catch (b) {
      sl(t, t.return, b);
    }
  }
  function ud(l) {
    var t = l.updateQueue;
    if (t !== null) {
      var e = l.stateNode;
      try {
        ws(t, e);
      } catch (a) {
        sl(l, l.return, a);
      }
    }
  }
  function nd(l, t, e) {
    e.props = Ve(
      l.type,
      l.memoizedProps
    ), e.state = l.memoizedState;
    try {
      e.componentWillUnmount();
    } catch (a) {
      sl(l, t, a);
    }
  }
  function ru(l, t) {
    try {
      var e = l.ref;
      if (e !== null) {
        switch (l.tag) {
          case 26:
          case 27:
          case 5:
            var a = l.stateNode;
            break;
          case 30:
            a = l.stateNode;
            break;
          default:
            a = l.stateNode;
        }
        typeof e == "function" ? l.refCleanup = e(a) : e.current = a;
      }
    } catch (u) {
      sl(l, t, u);
    }
  }
  function Rt(l, t) {
    var e = l.ref, a = l.refCleanup;
    if (e !== null)
      if (typeof a == "function")
        try {
          a();
        } catch (u) {
          sl(l, t, u);
        } finally {
          l.refCleanup = null, l = l.alternate, l != null && (l.refCleanup = null);
        }
      else if (typeof e == "function")
        try {
          e(null);
        } catch (u) {
          sl(l, t, u);
        }
      else e.current = null;
  }
  function id(l) {
    var t = l.type, e = l.memoizedProps, a = l.stateNode;
    try {
      l: switch (t) {
        case "button":
        case "input":
        case "select":
        case "textarea":
          e.autoFocus && a.focus();
          break l;
        case "img":
          e.src ? a.src = e.src : e.srcSet && (a.srcset = e.srcSet);
      }
    } catch (u) {
      sl(l, l.return, u);
    }
  }
  function Uc(l, t, e) {
    try {
      var a = l.stateNode;
      Bh(a, l.type, e, t), a[Wl] = t;
    } catch (u) {
      sl(l, l.return, u);
    }
  }
  function cd(l) {
    return l.tag === 5 || l.tag === 3 || l.tag === 26 || l.tag === 27 && pe(l.type) || l.tag === 4;
  }
  function Rc(l) {
    l: for (; ; ) {
      for (; l.sibling === null; ) {
        if (l.return === null || cd(l.return)) return null;
        l = l.return;
      }
      for (l.sibling.return = l.return, l = l.sibling; l.tag !== 5 && l.tag !== 6 && l.tag !== 18; ) {
        if (l.tag === 27 && pe(l.type) || l.flags & 2 || l.child === null || l.tag === 4) continue l;
        l.child.return = l, l = l.child;
      }
      if (!(l.flags & 2)) return l.stateNode;
    }
  }
  function Cc(l, t, e) {
    var a = l.tag;
    if (a === 5 || a === 6)
      l = l.stateNode, t ? (e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e).insertBefore(l, t) : (t = e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e, t.appendChild(l), e = e._reactRootContainer, e != null || t.onclick !== null || (t.onclick = Bt));
    else if (a !== 4 && (a === 27 && pe(l.type) && (e = l.stateNode, t = null), l = l.child, l !== null))
      for (Cc(l, t, e), l = l.sibling; l !== null; )
        Cc(l, t, e), l = l.sibling;
  }
  function Tn(l, t, e) {
    var a = l.tag;
    if (a === 5 || a === 6)
      l = l.stateNode, t ? e.insertBefore(l, t) : e.appendChild(l);
    else if (a !== 4 && (a === 27 && pe(l.type) && (e = l.stateNode), l = l.child, l !== null))
      for (Tn(l, t, e), l = l.sibling; l !== null; )
        Tn(l, t, e), l = l.sibling;
  }
  function fd(l) {
    var t = l.stateNode, e = l.memoizedProps;
    try {
      for (var a = l.type, u = t.attributes; u.length; )
        t.removeAttributeNode(u[0]);
      Xl(t, a, e), t[Bl] = l, t[Wl] = e;
    } catch (n) {
      sl(l, l.return, n);
    }
  }
  var wt = !1, Dl = !1, Hc = !1, sd = typeof WeakSet == "function" ? WeakSet : Set, ql = null;
  function yh(l, t) {
    if (l = l.containerInfo, ef = Vn, l = ps(l), Oi(l)) {
      if ("selectionStart" in l)
        var e = {
          start: l.selectionStart,
          end: l.selectionEnd
        };
      else
        l: {
          e = (e = l.ownerDocument) && e.defaultView || window;
          var a = e.getSelection && e.getSelection();
          if (a && a.rangeCount !== 0) {
            e = a.anchorNode;
            var u = a.anchorOffset, n = a.focusNode;
            a = a.focusOffset;
            try {
              e.nodeType, n.nodeType;
            } catch {
              e = null;
              break l;
            }
            var i = 0, c = -1, s = -1, y = 0, b = 0, j = l, g = null;
            t: for (; ; ) {
              for (var S; j !== e || u !== 0 && j.nodeType !== 3 || (c = i + u), j !== n || a !== 0 && j.nodeType !== 3 || (s = i + a), j.nodeType === 3 && (i += j.nodeValue.length), (S = j.firstChild) !== null; )
                g = j, j = S;
              for (; ; ) {
                if (j === l) break t;
                if (g === e && ++y === u && (c = i), g === n && ++b === a && (s = i), (S = j.nextSibling) !== null) break;
                j = g, g = j.parentNode;
              }
              j = S;
            }
            e = c === -1 || s === -1 ? null : { start: c, end: s };
          } else e = null;
        }
      e = e || { start: 0, end: 0 };
    } else e = null;
    for (af = { focusedElem: l, selectionRange: e }, Vn = !1, ql = t; ql !== null; )
      if (t = ql, l = t.child, (t.subtreeFlags & 1028) !== 0 && l !== null)
        l.return = t, ql = l;
      else
        for (; ql !== null; ) {
          switch (t = ql, n = t.alternate, l = t.flags, t.tag) {
            case 0:
              if ((l & 4) !== 0 && (l = t.updateQueue, l = l !== null ? l.events : null, l !== null))
                for (e = 0; e < l.length; e++)
                  u = l[e], u.ref.impl = u.nextImpl;
              break;
            case 11:
            case 15:
              break;
            case 1:
              if ((l & 1024) !== 0 && n !== null) {
                l = void 0, e = t, u = n.memoizedProps, n = n.memoizedState, a = e.stateNode;
                try {
                  var H = Ve(
                    e.type,
                    u
                  );
                  l = a.getSnapshotBeforeUpdate(
                    H,
                    n
                  ), a.__reactInternalSnapshotBeforeUpdate = l;
                } catch (L) {
                  sl(
                    e,
                    e.return,
                    L
                  );
                }
              }
              break;
            case 3:
              if ((l & 1024) !== 0) {
                if (l = t.stateNode.containerInfo, e = l.nodeType, e === 9)
                  cf(l);
                else if (e === 1)
                  switch (l.nodeName) {
                    case "HEAD":
                    case "HTML":
                    case "BODY":
                      cf(l);
                      break;
                    default:
                      l.textContent = "";
                  }
              }
              break;
            case 5:
            case 26:
            case 27:
            case 6:
            case 4:
            case 17:
              break;
            default:
              if ((l & 1024) !== 0) throw Error(d(163));
          }
          if (l = t.sibling, l !== null) {
            l.return = t.return, ql = l;
            break;
          }
          ql = t.return;
        }
  }
  function od(l, t, e) {
    var a = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 15:
        Wt(l, e), a & 4 && du(5, e);
        break;
      case 1:
        if (Wt(l, e), a & 4)
          if (l = e.stateNode, t === null)
            try {
              l.componentDidMount();
            } catch (i) {
              sl(e, e.return, i);
            }
          else {
            var u = Ve(
              e.type,
              t.memoizedProps
            );
            t = t.memoizedState;
            try {
              l.componentDidUpdate(
                u,
                t,
                l.__reactInternalSnapshotBeforeUpdate
              );
            } catch (i) {
              sl(
                e,
                e.return,
                i
              );
            }
          }
        a & 64 && ud(e), a & 512 && ru(e, e.return);
        break;
      case 3:
        if (Wt(l, e), a & 64 && (l = e.updateQueue, l !== null)) {
          if (t = null, e.child !== null)
            switch (e.child.tag) {
              case 27:
              case 5:
                t = e.child.stateNode;
                break;
              case 1:
                t = e.child.stateNode;
            }
          try {
            ws(l, t);
          } catch (i) {
            sl(e, e.return, i);
          }
        }
        break;
      case 27:
        t === null && a & 4 && fd(e);
      case 26:
      case 5:
        Wt(l, e), t === null && a & 4 && id(e), a & 512 && ru(e, e.return);
        break;
      case 12:
        Wt(l, e);
        break;
      case 31:
        Wt(l, e), a & 4 && md(l, e);
        break;
      case 13:
        Wt(l, e), a & 4 && hd(l, e), a & 64 && (l = e.memoizedState, l !== null && (l = l.dehydrated, l !== null && (e = Eh.bind(
          null,
          e
        ), Kh(l, e))));
        break;
      case 22:
        if (a = e.memoizedState !== null || wt, !a) {
          t = t !== null && t.memoizedState !== null || Dl, u = wt;
          var n = Dl;
          wt = a, (Dl = t) && !n ? kt(
            l,
            e,
            (e.subtreeFlags & 8772) !== 0
          ) : Wt(l, e), wt = u, Dl = n;
        }
        break;
      case 30:
        break;
      default:
        Wt(l, e);
    }
  }
  function dd(l) {
    var t = l.alternate;
    t !== null && (l.alternate = null, dd(t)), l.child = null, l.deletions = null, l.sibling = null, l.tag === 5 && (t = l.stateNode, t !== null && di(t)), l.stateNode = null, l.return = null, l.dependencies = null, l.memoizedProps = null, l.memoizedState = null, l.pendingProps = null, l.stateNode = null, l.updateQueue = null;
  }
  var bl = null, Fl = !1;
  function $t(l, t, e) {
    for (e = e.child; e !== null; )
      rd(l, t, e), e = e.sibling;
  }
  function rd(l, t, e) {
    if (nt && typeof nt.onCommitFiberUnmount == "function")
      try {
        nt.onCommitFiberUnmount(qa, e);
      } catch {
      }
    switch (e.tag) {
      case 26:
        Dl || Rt(e, t), $t(
          l,
          t,
          e
        ), e.memoizedState ? e.memoizedState.count-- : e.stateNode && (e = e.stateNode, e.parentNode.removeChild(e));
        break;
      case 27:
        Dl || Rt(e, t);
        var a = bl, u = Fl;
        pe(e.type) && (bl = e.stateNode, Fl = !1), $t(
          l,
          t,
          e
        ), Au(e.stateNode), bl = a, Fl = u;
        break;
      case 5:
        Dl || Rt(e, t);
      case 6:
        if (a = bl, u = Fl, bl = null, $t(
          l,
          t,
          e
        ), bl = a, Fl = u, bl !== null)
          if (Fl)
            try {
              (bl.nodeType === 9 ? bl.body : bl.nodeName === "HTML" ? bl.ownerDocument.body : bl).removeChild(e.stateNode);
            } catch (n) {
              sl(
                e,
                t,
                n
              );
            }
          else
            try {
              bl.removeChild(e.stateNode);
            } catch (n) {
              sl(
                e,
                t,
                n
              );
            }
        break;
      case 18:
        bl !== null && (Fl ? (l = bl, ur(
          l.nodeType === 9 ? l.body : l.nodeName === "HTML" ? l.ownerDocument.body : l,
          e.stateNode
        ), Ra(l)) : ur(bl, e.stateNode));
        break;
      case 4:
        a = bl, u = Fl, bl = e.stateNode.containerInfo, Fl = !0, $t(
          l,
          t,
          e
        ), bl = a, Fl = u;
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        me(2, e, t), Dl || me(4, e, t), $t(
          l,
          t,
          e
        );
        break;
      case 1:
        Dl || (Rt(e, t), a = e.stateNode, typeof a.componentWillUnmount == "function" && nd(
          e,
          t,
          a
        )), $t(
          l,
          t,
          e
        );
        break;
      case 21:
        $t(
          l,
          t,
          e
        );
        break;
      case 22:
        Dl = (a = Dl) || e.memoizedState !== null, $t(
          l,
          t,
          e
        ), Dl = a;
        break;
      default:
        $t(
          l,
          t,
          e
        );
    }
  }
  function md(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null))) {
      l = l.dehydrated;
      try {
        Ra(l);
      } catch (e) {
        sl(t, t.return, e);
      }
    }
  }
  function hd(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null && (l = l.dehydrated, l !== null))))
      try {
        Ra(l);
      } catch (e) {
        sl(t, t.return, e);
      }
  }
  function gh(l) {
    switch (l.tag) {
      case 31:
      case 13:
      case 19:
        var t = l.stateNode;
        return t === null && (t = l.stateNode = new sd()), t;
      case 22:
        return l = l.stateNode, t = l._retryCache, t === null && (t = l._retryCache = new sd()), t;
      default:
        throw Error(d(435, l.tag));
    }
  }
  function jn(l, t) {
    var e = gh(l);
    t.forEach(function(a) {
      if (!e.has(a)) {
        e.add(a);
        var u = xh.bind(null, l, a);
        a.then(u, u);
      }
    });
  }
  function Il(l, t) {
    var e = t.deletions;
    if (e !== null)
      for (var a = 0; a < e.length; a++) {
        var u = e[a], n = l, i = t, c = i;
        l: for (; c !== null; ) {
          switch (c.tag) {
            case 27:
              if (pe(c.type)) {
                bl = c.stateNode, Fl = !1;
                break l;
              }
              break;
            case 5:
              bl = c.stateNode, Fl = !1;
              break l;
            case 3:
            case 4:
              bl = c.stateNode.containerInfo, Fl = !0;
              break l;
          }
          c = c.return;
        }
        if (bl === null) throw Error(d(160));
        rd(n, i, u), bl = null, Fl = !1, n = u.alternate, n !== null && (n.return = null), u.return = null;
      }
    if (t.subtreeFlags & 13886)
      for (t = t.child; t !== null; )
        vd(t, l), t = t.sibling;
  }
  var Nt = null;
  function vd(l, t) {
    var e = l.alternate, a = l.flags;
    switch (l.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        Il(t, l), Pl(l), a & 4 && (me(3, l, l.return), du(3, l), me(5, l, l.return));
        break;
      case 1:
        Il(t, l), Pl(l), a & 512 && (Dl || e === null || Rt(e, e.return)), a & 64 && wt && (l = l.updateQueue, l !== null && (a = l.callbacks, a !== null && (e = l.shared.hiddenCallbacks, l.shared.hiddenCallbacks = e === null ? a : e.concat(a))));
        break;
      case 26:
        var u = Nt;
        if (Il(t, l), Pl(l), a & 512 && (Dl || e === null || Rt(e, e.return)), a & 4) {
          var n = e !== null ? e.memoizedState : null;
          if (a = l.memoizedState, e === null)
            if (a === null)
              if (l.stateNode === null) {
                l: {
                  a = l.type, e = l.memoizedProps, u = u.ownerDocument || u;
                  t: switch (a) {
                    case "title":
                      n = u.getElementsByTagName("title")[0], (!n || n[Ga] || n[Bl] || n.namespaceURI === "http://www.w3.org/2000/svg" || n.hasAttribute("itemprop")) && (n = u.createElement(a), u.head.insertBefore(
                        n,
                        u.querySelector("head > title")
                      )), Xl(n, a, e), n[Bl] = l, Hl(n), a = n;
                      break l;
                    case "link":
                      var i = vr(
                        "link",
                        "href",
                        u
                      ).get(a + (e.href || ""));
                      if (i) {
                        for (var c = 0; c < i.length; c++)
                          if (n = i[c], n.getAttribute("href") === (e.href == null || e.href === "" ? null : e.href) && n.getAttribute("rel") === (e.rel == null ? null : e.rel) && n.getAttribute("title") === (e.title == null ? null : e.title) && n.getAttribute("crossorigin") === (e.crossOrigin == null ? null : e.crossOrigin)) {
                            i.splice(c, 1);
                            break t;
                          }
                      }
                      n = u.createElement(a), Xl(n, a, e), u.head.appendChild(n);
                      break;
                    case "meta":
                      if (i = vr(
                        "meta",
                        "content",
                        u
                      ).get(a + (e.content || ""))) {
                        for (c = 0; c < i.length; c++)
                          if (n = i[c], n.getAttribute("content") === (e.content == null ? null : "" + e.content) && n.getAttribute("name") === (e.name == null ? null : e.name) && n.getAttribute("property") === (e.property == null ? null : e.property) && n.getAttribute("http-equiv") === (e.httpEquiv == null ? null : e.httpEquiv) && n.getAttribute("charset") === (e.charSet == null ? null : e.charSet)) {
                            i.splice(c, 1);
                            break t;
                          }
                      }
                      n = u.createElement(a), Xl(n, a, e), u.head.appendChild(n);
                      break;
                    default:
                      throw Error(d(468, a));
                  }
                  n[Bl] = l, Hl(n), a = n;
                }
                l.stateNode = a;
              } else
                yr(
                  u,
                  l.type,
                  l.stateNode
                );
            else
              l.stateNode = hr(
                u,
                a,
                l.memoizedProps
              );
          else
            n !== a ? (n === null ? e.stateNode !== null && (e = e.stateNode, e.parentNode.removeChild(e)) : n.count--, a === null ? yr(
              u,
              l.type,
              l.stateNode
            ) : hr(
              u,
              a,
              l.memoizedProps
            )) : a === null && l.stateNode !== null && Uc(
              l,
              l.memoizedProps,
              e.memoizedProps
            );
        }
        break;
      case 27:
        Il(t, l), Pl(l), a & 512 && (Dl || e === null || Rt(e, e.return)), e !== null && a & 4 && Uc(
          l,
          l.memoizedProps,
          e.memoizedProps
        );
        break;
      case 5:
        if (Il(t, l), Pl(l), a & 512 && (Dl || e === null || Rt(e, e.return)), l.flags & 32) {
          u = l.stateNode;
          try {
            ea(u, "");
          } catch (H) {
            sl(l, l.return, H);
          }
        }
        a & 4 && l.stateNode != null && (u = l.memoizedProps, Uc(
          l,
          u,
          e !== null ? e.memoizedProps : u
        )), a & 1024 && (Hc = !0);
        break;
      case 6:
        if (Il(t, l), Pl(l), a & 4) {
          if (l.stateNode === null)
            throw Error(d(162));
          a = l.memoizedProps, e = l.stateNode;
          try {
            e.nodeValue = a;
          } catch (H) {
            sl(l, l.return, H);
          }
        }
        break;
      case 3:
        if (Ln = null, u = Nt, Nt = Yn(t.containerInfo), Il(t, l), Nt = u, Pl(l), a & 4 && e !== null && e.memoizedState.isDehydrated)
          try {
            Ra(t.containerInfo);
          } catch (H) {
            sl(l, l.return, H);
          }
        Hc && (Hc = !1, yd(l));
        break;
      case 4:
        a = Nt, Nt = Yn(
          l.stateNode.containerInfo
        ), Il(t, l), Pl(l), Nt = a;
        break;
      case 12:
        Il(t, l), Pl(l);
        break;
      case 31:
        Il(t, l), Pl(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, jn(l, a)));
        break;
      case 13:
        Il(t, l), Pl(l), l.child.flags & 8192 && l.memoizedState !== null != (e !== null && e.memoizedState !== null) && (xn = ut()), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, jn(l, a)));
        break;
      case 22:
        u = l.memoizedState !== null;
        var s = e !== null && e.memoizedState !== null, y = wt, b = Dl;
        if (wt = y || u, Dl = b || s, Il(t, l), Dl = b, wt = y, Pl(l), a & 8192)
          l: for (t = l.stateNode, t._visibility = u ? t._visibility & -2 : t._visibility | 1, u && (e === null || s || wt || Dl || Ke(l)), e = null, t = l; ; ) {
            if (t.tag === 5 || t.tag === 26) {
              if (e === null) {
                s = e = t;
                try {
                  if (n = s.stateNode, u)
                    i = n.style, typeof i.setProperty == "function" ? i.setProperty("display", "none", "important") : i.display = "none";
                  else {
                    c = s.stateNode;
                    var j = s.memoizedProps.style, g = j != null && j.hasOwnProperty("display") ? j.display : null;
                    c.style.display = g == null || typeof g == "boolean" ? "" : ("" + g).trim();
                  }
                } catch (H) {
                  sl(s, s.return, H);
                }
              }
            } else if (t.tag === 6) {
              if (e === null) {
                s = t;
                try {
                  s.stateNode.nodeValue = u ? "" : s.memoizedProps;
                } catch (H) {
                  sl(s, s.return, H);
                }
              }
            } else if (t.tag === 18) {
              if (e === null) {
                s = t;
                try {
                  var S = s.stateNode;
                  u ? nr(S, !0) : nr(s.stateNode, !1);
                } catch (H) {
                  sl(s, s.return, H);
                }
              }
            } else if ((t.tag !== 22 && t.tag !== 23 || t.memoizedState === null || t === l) && t.child !== null) {
              t.child.return = t, t = t.child;
              continue;
            }
            if (t === l) break l;
            for (; t.sibling === null; ) {
              if (t.return === null || t.return === l) break l;
              e === t && (e = null), t = t.return;
            }
            e === t && (e = null), t.sibling.return = t.return, t = t.sibling;
          }
        a & 4 && (a = l.updateQueue, a !== null && (e = a.retryQueue, e !== null && (a.retryQueue = null, jn(l, e))));
        break;
      case 19:
        Il(t, l), Pl(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, jn(l, a)));
        break;
      case 30:
        break;
      case 21:
        break;
      default:
        Il(t, l), Pl(l);
    }
  }
  function Pl(l) {
    var t = l.flags;
    if (t & 2) {
      try {
        for (var e, a = l.return; a !== null; ) {
          if (cd(a)) {
            e = a;
            break;
          }
          a = a.return;
        }
        if (e == null) throw Error(d(160));
        switch (e.tag) {
          case 27:
            var u = e.stateNode, n = Rc(l);
            Tn(l, n, u);
            break;
          case 5:
            var i = e.stateNode;
            e.flags & 32 && (ea(i, ""), e.flags &= -33);
            var c = Rc(l);
            Tn(l, c, i);
            break;
          case 3:
          case 4:
            var s = e.stateNode.containerInfo, y = Rc(l);
            Cc(
              l,
              y,
              s
            );
            break;
          default:
            throw Error(d(161));
        }
      } catch (b) {
        sl(l, l.return, b);
      }
      l.flags &= -3;
    }
    t & 4096 && (l.flags &= -4097);
  }
  function yd(l) {
    if (l.subtreeFlags & 1024)
      for (l = l.child; l !== null; ) {
        var t = l;
        yd(t), t.tag === 5 && t.flags & 1024 && t.stateNode.reset(), l = l.sibling;
      }
  }
  function Wt(l, t) {
    if (t.subtreeFlags & 8772)
      for (t = t.child; t !== null; )
        od(l, t.alternate, t), t = t.sibling;
  }
  function Ke(l) {
    for (l = l.child; l !== null; ) {
      var t = l;
      switch (t.tag) {
        case 0:
        case 11:
        case 14:
        case 15:
          me(4, t, t.return), Ke(t);
          break;
        case 1:
          Rt(t, t.return);
          var e = t.stateNode;
          typeof e.componentWillUnmount == "function" && nd(
            t,
            t.return,
            e
          ), Ke(t);
          break;
        case 27:
          Au(t.stateNode);
        case 26:
        case 5:
          Rt(t, t.return), Ke(t);
          break;
        case 22:
          t.memoizedState === null && Ke(t);
          break;
        case 30:
          Ke(t);
          break;
        default:
          Ke(t);
      }
      l = l.sibling;
    }
  }
  function kt(l, t, e) {
    for (e = e && (t.subtreeFlags & 8772) !== 0, t = t.child; t !== null; ) {
      var a = t.alternate, u = l, n = t, i = n.flags;
      switch (n.tag) {
        case 0:
        case 11:
        case 15:
          kt(
            u,
            n,
            e
          ), du(4, n);
          break;
        case 1:
          if (kt(
            u,
            n,
            e
          ), a = n, u = a.stateNode, typeof u.componentDidMount == "function")
            try {
              u.componentDidMount();
            } catch (y) {
              sl(a, a.return, y);
            }
          if (a = n, u = a.updateQueue, u !== null) {
            var c = a.stateNode;
            try {
              var s = u.shared.hiddenCallbacks;
              if (s !== null)
                for (u.shared.hiddenCallbacks = null, u = 0; u < s.length; u++)
                  Js(s[u], c);
            } catch (y) {
              sl(a, a.return, y);
            }
          }
          e && i & 64 && ud(n), ru(n, n.return);
          break;
        case 27:
          fd(n);
        case 26:
        case 5:
          kt(
            u,
            n,
            e
          ), e && a === null && i & 4 && id(n), ru(n, n.return);
          break;
        case 12:
          kt(
            u,
            n,
            e
          );
          break;
        case 31:
          kt(
            u,
            n,
            e
          ), e && i & 4 && md(u, n);
          break;
        case 13:
          kt(
            u,
            n,
            e
          ), e && i & 4 && hd(u, n);
          break;
        case 22:
          n.memoizedState === null && kt(
            u,
            n,
            e
          ), ru(n, n.return);
          break;
        case 30:
          break;
        default:
          kt(
            u,
            n,
            e
          );
      }
      t = t.sibling;
    }
  }
  function qc(l, t) {
    var e = null;
    l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (e = l.memoizedState.cachePool.pool), l = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (l = t.memoizedState.cachePool.pool), l !== e && (l != null && l.refCount++, e != null && Ia(e));
  }
  function Bc(l, t) {
    l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Ia(l));
  }
  function Ot(l, t, e, a) {
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; )
        gd(
          l,
          t,
          e,
          a
        ), t = t.sibling;
  }
  function gd(l, t, e, a) {
    var u = t.flags;
    switch (t.tag) {
      case 0:
      case 11:
      case 15:
        Ot(
          l,
          t,
          e,
          a
        ), u & 2048 && du(9, t);
        break;
      case 1:
        Ot(
          l,
          t,
          e,
          a
        );
        break;
      case 3:
        Ot(
          l,
          t,
          e,
          a
        ), u & 2048 && (l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Ia(l)));
        break;
      case 12:
        if (u & 2048) {
          Ot(
            l,
            t,
            e,
            a
          ), l = t.stateNode;
          try {
            var n = t.memoizedProps, i = n.id, c = n.onPostCommit;
            typeof c == "function" && c(
              i,
              t.alternate === null ? "mount" : "update",
              l.passiveEffectDuration,
              -0
            );
          } catch (s) {
            sl(t, t.return, s);
          }
        } else
          Ot(
            l,
            t,
            e,
            a
          );
        break;
      case 31:
        Ot(
          l,
          t,
          e,
          a
        );
        break;
      case 13:
        Ot(
          l,
          t,
          e,
          a
        );
        break;
      case 23:
        break;
      case 22:
        n = t.stateNode, i = t.alternate, t.memoizedState !== null ? n._visibility & 2 ? Ot(
          l,
          t,
          e,
          a
        ) : mu(l, t) : n._visibility & 2 ? Ot(
          l,
          t,
          e,
          a
        ) : (n._visibility |= 2, za(
          l,
          t,
          e,
          a,
          (t.subtreeFlags & 10256) !== 0 || !1
        )), u & 2048 && qc(i, t);
        break;
      case 24:
        Ot(
          l,
          t,
          e,
          a
        ), u & 2048 && Bc(t.alternate, t);
        break;
      default:
        Ot(
          l,
          t,
          e,
          a
        );
    }
  }
  function za(l, t, e, a, u) {
    for (u = u && ((t.subtreeFlags & 10256) !== 0 || !1), t = t.child; t !== null; ) {
      var n = l, i = t, c = e, s = a, y = i.flags;
      switch (i.tag) {
        case 0:
        case 11:
        case 15:
          za(
            n,
            i,
            c,
            s,
            u
          ), du(8, i);
          break;
        case 23:
          break;
        case 22:
          var b = i.stateNode;
          i.memoizedState !== null ? b._visibility & 2 ? za(
            n,
            i,
            c,
            s,
            u
          ) : mu(
            n,
            i
          ) : (b._visibility |= 2, za(
            n,
            i,
            c,
            s,
            u
          )), u && y & 2048 && qc(
            i.alternate,
            i
          );
          break;
        case 24:
          za(
            n,
            i,
            c,
            s,
            u
          ), u && y & 2048 && Bc(i.alternate, i);
          break;
        default:
          za(
            n,
            i,
            c,
            s,
            u
          );
      }
      t = t.sibling;
    }
  }
  function mu(l, t) {
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; ) {
        var e = l, a = t, u = a.flags;
        switch (a.tag) {
          case 22:
            mu(e, a), u & 2048 && qc(
              a.alternate,
              a
            );
            break;
          case 24:
            mu(e, a), u & 2048 && Bc(a.alternate, a);
            break;
          default:
            mu(e, a);
        }
        t = t.sibling;
      }
  }
  var hu = 8192;
  function Ta(l, t, e) {
    if (l.subtreeFlags & hu)
      for (l = l.child; l !== null; )
        Sd(
          l,
          t,
          e
        ), l = l.sibling;
  }
  function Sd(l, t, e) {
    switch (l.tag) {
      case 26:
        Ta(
          l,
          t,
          e
        ), l.flags & hu && l.memoizedState !== null && av(
          e,
          Nt,
          l.memoizedState,
          l.memoizedProps
        );
        break;
      case 5:
        Ta(
          l,
          t,
          e
        );
        break;
      case 3:
      case 4:
        var a = Nt;
        Nt = Yn(l.stateNode.containerInfo), Ta(
          l,
          t,
          e
        ), Nt = a;
        break;
      case 22:
        l.memoizedState === null && (a = l.alternate, a !== null && a.memoizedState !== null ? (a = hu, hu = 16777216, Ta(
          l,
          t,
          e
        ), hu = a) : Ta(
          l,
          t,
          e
        ));
        break;
      default:
        Ta(
          l,
          t,
          e
        );
    }
  }
  function bd(l) {
    var t = l.alternate;
    if (t !== null && (l = t.child, l !== null)) {
      t.child = null;
      do
        t = l.sibling, l.sibling = null, l = t;
      while (l !== null);
    }
  }
  function vu(l) {
    var t = l.deletions;
    if ((l.flags & 16) !== 0) {
      if (t !== null)
        for (var e = 0; e < t.length; e++) {
          var a = t[e];
          ql = a, Ad(
            a,
            l
          );
        }
      bd(l);
    }
    if (l.subtreeFlags & 10256)
      for (l = l.child; l !== null; )
        pd(l), l = l.sibling;
  }
  function pd(l) {
    switch (l.tag) {
      case 0:
      case 11:
      case 15:
        vu(l), l.flags & 2048 && me(9, l, l.return);
        break;
      case 3:
        vu(l);
        break;
      case 12:
        vu(l);
        break;
      case 22:
        var t = l.stateNode;
        l.memoizedState !== null && t._visibility & 2 && (l.return === null || l.return.tag !== 13) ? (t._visibility &= -3, En(l)) : vu(l);
        break;
      default:
        vu(l);
    }
  }
  function En(l) {
    var t = l.deletions;
    if ((l.flags & 16) !== 0) {
      if (t !== null)
        for (var e = 0; e < t.length; e++) {
          var a = t[e];
          ql = a, Ad(
            a,
            l
          );
        }
      bd(l);
    }
    for (l = l.child; l !== null; ) {
      switch (t = l, t.tag) {
        case 0:
        case 11:
        case 15:
          me(8, t, t.return), En(t);
          break;
        case 22:
          e = t.stateNode, e._visibility & 2 && (e._visibility &= -3, En(t));
          break;
        default:
          En(t);
      }
      l = l.sibling;
    }
  }
  function Ad(l, t) {
    for (; ql !== null; ) {
      var e = ql;
      switch (e.tag) {
        case 0:
        case 11:
        case 15:
          me(8, e, t);
          break;
        case 23:
        case 22:
          if (e.memoizedState !== null && e.memoizedState.cachePool !== null) {
            var a = e.memoizedState.cachePool.pool;
            a != null && a.refCount++;
          }
          break;
        case 24:
          Ia(e.memoizedState.cache);
      }
      if (a = e.child, a !== null) a.return = e, ql = a;
      else
        l: for (e = l; ql !== null; ) {
          a = ql;
          var u = a.sibling, n = a.return;
          if (dd(a), a === e) {
            ql = null;
            break l;
          }
          if (u !== null) {
            u.return = n, ql = u;
            break l;
          }
          ql = n;
        }
    }
  }
  var Sh = {
    getCacheForType: function(l) {
      var t = Gl(Ol), e = t.data.get(l);
      return e === void 0 && (e = l(), t.data.set(l, e)), e;
    },
    cacheSignal: function() {
      return Gl(Ol).controller.signal;
    }
  }, bh = typeof WeakMap == "function" ? WeakMap : Map, nl = 0, vl = null, F = null, P = 0, fl = 0, dt = null, he = !1, ja = !1, Yc = !1, Ft = 0, Al = 0, ve = 0, Je = 0, Gc = 0, rt = 0, Ea = 0, yu = null, lt = null, Lc = !1, xn = 0, zd = 0, Nn = 1 / 0, On = null, ye = null, Ul = 0, ge = null, xa = null, It = 0, Xc = 0, Qc = null, Td = null, gu = 0, Zc = null;
  function mt() {
    return (nl & 2) !== 0 && P !== 0 ? P & -P : A.T !== null ? Wc() : Yf();
  }
  function jd() {
    if (rt === 0)
      if ((P & 536870912) === 0 || el) {
        var l = Hu;
        Hu <<= 1, (Hu & 3932160) === 0 && (Hu = 262144), rt = l;
      } else rt = 536870912;
    return l = st.current, l !== null && (l.flags |= 32), rt;
  }
  function tt(l, t, e) {
    (l === vl && (fl === 2 || fl === 9) || l.cancelPendingCommit !== null) && (Na(l, 0), Se(
      l,
      P,
      rt,
      !1
    )), Ya(l, e), ((nl & 2) === 0 || l !== vl) && (l === vl && ((nl & 2) === 0 && (Je |= e), Al === 4 && Se(
      l,
      P,
      rt,
      !1
    )), Ct(l));
  }
  function Ed(l, t, e) {
    if ((nl & 6) !== 0) throw Error(d(327));
    var a = !e && (t & 127) === 0 && (t & l.expiredLanes) === 0 || Ba(l, t), u = a ? zh(l, t) : Kc(l, t, !0), n = a;
    do {
      if (u === 0) {
        ja && !a && Se(l, t, 0, !1);
        break;
      } else {
        if (e = l.current.alternate, n && !ph(e)) {
          u = Kc(l, t, !1), n = !1;
          continue;
        }
        if (u === 2) {
          if (n = t, l.errorRecoveryDisabledLanes & n)
            var i = 0;
          else
            i = l.pendingLanes & -536870913, i = i !== 0 ? i : i & 536870912 ? 536870912 : 0;
          if (i !== 0) {
            t = i;
            l: {
              var c = l;
              u = yu;
              var s = c.current.memoizedState.isDehydrated;
              if (s && (Na(c, i).flags |= 256), i = Kc(
                c,
                i,
                !1
              ), i !== 2) {
                if (Yc && !s) {
                  c.errorRecoveryDisabledLanes |= n, Je |= n, u = 4;
                  break l;
                }
                n = lt, lt = u, n !== null && (lt === null ? lt = n : lt.push.apply(
                  lt,
                  n
                ));
              }
              u = i;
            }
            if (n = !1, u !== 2) continue;
          }
        }
        if (u === 1) {
          Na(l, 0), Se(l, t, 0, !0);
          break;
        }
        l: {
          switch (a = l, n = u, n) {
            case 0:
            case 1:
              throw Error(d(345));
            case 4:
              if ((t & 4194048) !== t) break;
            case 6:
              Se(
                a,
                t,
                rt,
                !he
              );
              break l;
            case 2:
              lt = null;
              break;
            case 3:
            case 5:
              break;
            default:
              throw Error(d(329));
          }
          if ((t & 62914560) === t && (u = xn + 300 - ut(), 10 < u)) {
            if (Se(
              a,
              t,
              rt,
              !he
            ), Bu(a, 0, !0) !== 0) break l;
            It = t, a.timeoutHandle = er(
              xd.bind(
                null,
                a,
                e,
                lt,
                On,
                Lc,
                t,
                rt,
                Je,
                Ea,
                he,
                n,
                "Throttled",
                -0,
                0
              ),
              u
            );
            break l;
          }
          xd(
            a,
            e,
            lt,
            On,
            Lc,
            t,
            rt,
            Je,
            Ea,
            he,
            n,
            null,
            -0,
            0
          );
        }
      }
      break;
    } while (!0);
    Ct(l);
  }
  function xd(l, t, e, a, u, n, i, c, s, y, b, j, g, S) {
    if (l.timeoutHandle = -1, j = t.subtreeFlags, j & 8192 || (j & 16785408) === 16785408) {
      j = {
        stylesheets: null,
        count: 0,
        imgCount: 0,
        imgBytes: 0,
        suspenseyImages: [],
        waitingForImages: !0,
        waitingForViewTransition: !1,
        unsuspend: Bt
      }, Sd(
        t,
        n,
        j
      );
      var H = (n & 62914560) === n ? xn - ut() : (n & 4194048) === n ? zd - ut() : 0;
      if (H = uv(
        j,
        H
      ), H !== null) {
        It = n, l.cancelPendingCommit = H(
          Cd.bind(
            null,
            l,
            t,
            n,
            e,
            a,
            u,
            i,
            c,
            s,
            b,
            j,
            null,
            g,
            S
          )
        ), Se(l, n, i, !y);
        return;
      }
    }
    Cd(
      l,
      t,
      n,
      e,
      a,
      u,
      i,
      c,
      s
    );
  }
  function ph(l) {
    for (var t = l; ; ) {
      var e = t.tag;
      if ((e === 0 || e === 11 || e === 15) && t.flags & 16384 && (e = t.updateQueue, e !== null && (e = e.stores, e !== null)))
        for (var a = 0; a < e.length; a++) {
          var u = e[a], n = u.getSnapshot;
          u = u.value;
          try {
            if (!ct(n(), u)) return !1;
          } catch {
            return !1;
          }
        }
      if (e = t.child, t.subtreeFlags & 16384 && e !== null)
        e.return = t, t = e;
      else {
        if (t === l) break;
        for (; t.sibling === null; ) {
          if (t.return === null || t.return === l) return !0;
          t = t.return;
        }
        t.sibling.return = t.return, t = t.sibling;
      }
    }
    return !0;
  }
  function Se(l, t, e, a) {
    t &= ~Gc, t &= ~Je, l.suspendedLanes |= t, l.pingedLanes &= ~t, a && (l.warmLanes |= t), a = l.expirationTimes;
    for (var u = t; 0 < u; ) {
      var n = 31 - it(u), i = 1 << n;
      a[n] = -1, u &= ~i;
    }
    e !== 0 && Hf(l, e, t);
  }
  function _n() {
    return (nl & 6) === 0 ? (Su(0), !1) : !0;
  }
  function Vc() {
    if (F !== null) {
      if (fl === 0)
        var l = F.return;
      else
        l = F, Xt = Be = null, ic(l), ga = null, lu = 0, l = F;
      for (; l !== null; )
        ad(l.alternate, l), l = l.return;
      F = null;
    }
  }
  function Na(l, t) {
    var e = l.timeoutHandle;
    e !== -1 && (l.timeoutHandle = -1, Lh(e)), e = l.cancelPendingCommit, e !== null && (l.cancelPendingCommit = null, e()), It = 0, Vc(), vl = l, F = e = Gt(l.current, null), P = t, fl = 0, dt = null, he = !1, ja = Ba(l, t), Yc = !1, Ea = rt = Gc = Je = ve = Al = 0, lt = yu = null, Lc = !1, (t & 8) !== 0 && (t |= t & 32);
    var a = l.entangledLanes;
    if (a !== 0)
      for (l = l.entanglements, a &= t; 0 < a; ) {
        var u = 31 - it(a), n = 1 << u;
        t |= l[u], a &= ~n;
      }
    return Ft = t, Wu(), e;
  }
  function Nd(l, t) {
    w = null, A.H = fu, t === ya || t === an ? (t = Qs(), fl = 3) : t === $i ? (t = Qs(), fl = 4) : fl = t === zc ? 8 : t !== null && typeof t == "object" && typeof t.then == "function" ? 6 : 1, dt = t, F === null && (Al = 1, Sn(
      l,
      St(t, l.current)
    ));
  }
  function Od() {
    var l = st.current;
    return l === null ? !0 : (P & 4194048) === P ? zt === null : (P & 62914560) === P || (P & 536870912) !== 0 ? l === zt : !1;
  }
  function _d() {
    var l = A.H;
    return A.H = fu, l === null ? fu : l;
  }
  function Md() {
    var l = A.A;
    return A.A = Sh, l;
  }
  function Mn() {
    Al = 4, he || (P & 4194048) !== P && st.current !== null || (ja = !0), (ve & 134217727) === 0 && (Je & 134217727) === 0 || vl === null || Se(
      vl,
      P,
      rt,
      !1
    );
  }
  function Kc(l, t, e) {
    var a = nl;
    nl |= 2;
    var u = _d(), n = Md();
    (vl !== l || P !== t) && (On = null, Na(l, t)), t = !1;
    var i = Al;
    l: do
      try {
        if (fl !== 0 && F !== null) {
          var c = F, s = dt;
          switch (fl) {
            case 8:
              Vc(), i = 6;
              break l;
            case 3:
            case 2:
            case 9:
            case 6:
              st.current === null && (t = !0);
              var y = fl;
              if (fl = 0, dt = null, Oa(l, c, s, y), e && ja) {
                i = 0;
                break l;
              }
              break;
            default:
              y = fl, fl = 0, dt = null, Oa(l, c, s, y);
          }
        }
        Ah(), i = Al;
        break;
      } catch (b) {
        Nd(l, b);
      }
    while (!0);
    return t && l.shellSuspendCounter++, Xt = Be = null, nl = a, A.H = u, A.A = n, F === null && (vl = null, P = 0, Wu()), i;
  }
  function Ah() {
    for (; F !== null; ) Dd(F);
  }
  function zh(l, t) {
    var e = nl;
    nl |= 2;
    var a = _d(), u = Md();
    vl !== l || P !== t ? (On = null, Nn = ut() + 500, Na(l, t)) : ja = Ba(
      l,
      t
    );
    l: do
      try {
        if (fl !== 0 && F !== null) {
          t = F;
          var n = dt;
          t: switch (fl) {
            case 1:
              fl = 0, dt = null, Oa(l, t, n, 1);
              break;
            case 2:
            case 9:
              if (Ls(n)) {
                fl = 0, dt = null, Ud(t);
                break;
              }
              t = function() {
                fl !== 2 && fl !== 9 || vl !== l || (fl = 7), Ct(l);
              }, n.then(t, t);
              break l;
            case 3:
              fl = 7;
              break l;
            case 4:
              fl = 5;
              break l;
            case 7:
              Ls(n) ? (fl = 0, dt = null, Ud(t)) : (fl = 0, dt = null, Oa(l, t, n, 7));
              break;
            case 5:
              var i = null;
              switch (F.tag) {
                case 26:
                  i = F.memoizedState;
                case 5:
                case 27:
                  var c = F;
                  if (i ? gr(i) : c.stateNode.complete) {
                    fl = 0, dt = null;
                    var s = c.sibling;
                    if (s !== null) F = s;
                    else {
                      var y = c.return;
                      y !== null ? (F = y, Dn(y)) : F = null;
                    }
                    break t;
                  }
              }
              fl = 0, dt = null, Oa(l, t, n, 5);
              break;
            case 6:
              fl = 0, dt = null, Oa(l, t, n, 6);
              break;
            case 8:
              Vc(), Al = 6;
              break l;
            default:
              throw Error(d(462));
          }
        }
        Th();
        break;
      } catch (b) {
        Nd(l, b);
      }
    while (!0);
    return Xt = Be = null, A.H = a, A.A = u, nl = e, F !== null ? 0 : (vl = null, P = 0, Wu(), Al);
  }
  function Th() {
    for (; F !== null && !Jr(); )
      Dd(F);
  }
  function Dd(l) {
    var t = td(l.alternate, l, Ft);
    l.memoizedProps = l.pendingProps, t === null ? Dn(l) : F = t;
  }
  function Ud(l) {
    var t = l, e = t.alternate;
    switch (t.tag) {
      case 15:
      case 0:
        t = Wo(
          e,
          t,
          t.pendingProps,
          t.type,
          void 0,
          P
        );
        break;
      case 11:
        t = Wo(
          e,
          t,
          t.pendingProps,
          t.type.render,
          t.ref,
          P
        );
        break;
      case 5:
        ic(t);
      default:
        ad(e, t), t = F = _s(t, Ft), t = td(e, t, Ft);
    }
    l.memoizedProps = l.pendingProps, t === null ? Dn(l) : F = t;
  }
  function Oa(l, t, e, a) {
    Xt = Be = null, ic(t), ga = null, lu = 0;
    var u = t.return;
    try {
      if (dh(
        l,
        u,
        t,
        e,
        P
      )) {
        Al = 1, Sn(
          l,
          St(e, l.current)
        ), F = null;
        return;
      }
    } catch (n) {
      if (u !== null) throw F = u, n;
      Al = 1, Sn(
        l,
        St(e, l.current)
      ), F = null;
      return;
    }
    t.flags & 32768 ? (el || a === 1 ? l = !0 : ja || (P & 536870912) !== 0 ? l = !1 : (he = l = !0, (a === 2 || a === 9 || a === 3 || a === 6) && (a = st.current, a !== null && a.tag === 13 && (a.flags |= 16384))), Rd(t, l)) : Dn(t);
  }
  function Dn(l) {
    var t = l;
    do {
      if ((t.flags & 32768) !== 0) {
        Rd(
          t,
          he
        );
        return;
      }
      l = t.return;
      var e = hh(
        t.alternate,
        t,
        Ft
      );
      if (e !== null) {
        F = e;
        return;
      }
      if (t = t.sibling, t !== null) {
        F = t;
        return;
      }
      F = t = l;
    } while (t !== null);
    Al === 0 && (Al = 5);
  }
  function Rd(l, t) {
    do {
      var e = vh(l.alternate, l);
      if (e !== null) {
        e.flags &= 32767, F = e;
        return;
      }
      if (e = l.return, e !== null && (e.flags |= 32768, e.subtreeFlags = 0, e.deletions = null), !t && (l = l.sibling, l !== null)) {
        F = l;
        return;
      }
      F = l = e;
    } while (l !== null);
    Al = 6, F = null;
  }
  function Cd(l, t, e, a, u, n, i, c, s) {
    l.cancelPendingCommit = null;
    do
      Un();
    while (Ul !== 0);
    if ((nl & 6) !== 0) throw Error(d(327));
    if (t !== null) {
      if (t === l.current) throw Error(d(177));
      if (n = t.lanes | t.childLanes, n |= Ri, em(
        l,
        e,
        n,
        i,
        c,
        s
      ), l === vl && (F = vl = null, P = 0), xa = t, ge = l, It = e, Xc = n, Qc = u, Td = a, (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? (l.callbackNode = null, l.callbackPriority = 0, Nh(Ru, function() {
        return Gd(), null;
      })) : (l.callbackNode = null, l.callbackPriority = 0), a = (t.flags & 13878) !== 0, (t.subtreeFlags & 13878) !== 0 || a) {
        a = A.T, A.T = null, u = U.p, U.p = 2, i = nl, nl |= 4;
        try {
          yh(l, t, e);
        } finally {
          nl = i, U.p = u, A.T = a;
        }
      }
      Ul = 1, Hd(), qd(), Bd();
    }
  }
  function Hd() {
    if (Ul === 1) {
      Ul = 0;
      var l = ge, t = xa, e = (t.flags & 13878) !== 0;
      if ((t.subtreeFlags & 13878) !== 0 || e) {
        e = A.T, A.T = null;
        var a = U.p;
        U.p = 2;
        var u = nl;
        nl |= 4;
        try {
          vd(t, l);
          var n = af, i = ps(l.containerInfo), c = n.focusedElem, s = n.selectionRange;
          if (i !== c && c && c.ownerDocument && bs(
            c.ownerDocument.documentElement,
            c
          )) {
            if (s !== null && Oi(c)) {
              var y = s.start, b = s.end;
              if (b === void 0 && (b = y), "selectionStart" in c)
                c.selectionStart = y, c.selectionEnd = Math.min(
                  b,
                  c.value.length
                );
              else {
                var j = c.ownerDocument || document, g = j && j.defaultView || window;
                if (g.getSelection) {
                  var S = g.getSelection(), H = c.textContent.length, L = Math.min(s.start, H), ml = s.end === void 0 ? L : Math.min(s.end, H);
                  !S.extend && L > ml && (i = ml, ml = L, L = i);
                  var h = Ss(
                    c,
                    L
                  ), o = Ss(
                    c,
                    ml
                  );
                  if (h && o && (S.rangeCount !== 1 || S.anchorNode !== h.node || S.anchorOffset !== h.offset || S.focusNode !== o.node || S.focusOffset !== o.offset)) {
                    var v = j.createRange();
                    v.setStart(h.node, h.offset), S.removeAllRanges(), L > ml ? (S.addRange(v), S.extend(o.node, o.offset)) : (v.setEnd(o.node, o.offset), S.addRange(v));
                  }
                }
              }
            }
            for (j = [], S = c; S = S.parentNode; )
              S.nodeType === 1 && j.push({
                element: S,
                left: S.scrollLeft,
                top: S.scrollTop
              });
            for (typeof c.focus == "function" && c.focus(), c = 0; c < j.length; c++) {
              var T = j[c];
              T.element.scrollLeft = T.left, T.element.scrollTop = T.top;
            }
          }
          Vn = !!ef, af = ef = null;
        } finally {
          nl = u, U.p = a, A.T = e;
        }
      }
      l.current = t, Ul = 2;
    }
  }
  function qd() {
    if (Ul === 2) {
      Ul = 0;
      var l = ge, t = xa, e = (t.flags & 8772) !== 0;
      if ((t.subtreeFlags & 8772) !== 0 || e) {
        e = A.T, A.T = null;
        var a = U.p;
        U.p = 2;
        var u = nl;
        nl |= 4;
        try {
          od(l, t.alternate, t);
        } finally {
          nl = u, U.p = a, A.T = e;
        }
      }
      Ul = 3;
    }
  }
  function Bd() {
    if (Ul === 4 || Ul === 3) {
      Ul = 0, wr();
      var l = ge, t = xa, e = It, a = Td;
      (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? Ul = 5 : (Ul = 0, xa = ge = null, Yd(l, l.pendingLanes));
      var u = l.pendingLanes;
      if (u === 0 && (ye = null), si(e), t = t.stateNode, nt && typeof nt.onCommitFiberRoot == "function")
        try {
          nt.onCommitFiberRoot(
            qa,
            t,
            void 0,
            (t.current.flags & 128) === 128
          );
        } catch {
        }
      if (a !== null) {
        t = A.T, u = U.p, U.p = 2, A.T = null;
        try {
          for (var n = l.onRecoverableError, i = 0; i < a.length; i++) {
            var c = a[i];
            n(c.value, {
              componentStack: c.stack
            });
          }
        } finally {
          A.T = t, U.p = u;
        }
      }
      (It & 3) !== 0 && Un(), Ct(l), u = l.pendingLanes, (e & 261930) !== 0 && (u & 42) !== 0 ? l === Zc ? gu++ : (gu = 0, Zc = l) : gu = 0, Su(0);
    }
  }
  function Yd(l, t) {
    (l.pooledCacheLanes &= t) === 0 && (t = l.pooledCache, t != null && (l.pooledCache = null, Ia(t)));
  }
  function Un() {
    return Hd(), qd(), Bd(), Gd();
  }
  function Gd() {
    if (Ul !== 5) return !1;
    var l = ge, t = Xc;
    Xc = 0;
    var e = si(It), a = A.T, u = U.p;
    try {
      U.p = 32 > e ? 32 : e, A.T = null, e = Qc, Qc = null;
      var n = ge, i = It;
      if (Ul = 0, xa = ge = null, It = 0, (nl & 6) !== 0) throw Error(d(331));
      var c = nl;
      if (nl |= 4, pd(n.current), gd(
        n,
        n.current,
        i,
        e
      ), nl = c, Su(0, !1), nt && typeof nt.onPostCommitFiberRoot == "function")
        try {
          nt.onPostCommitFiberRoot(qa, n);
        } catch {
        }
      return !0;
    } finally {
      U.p = u, A.T = a, Yd(l, t);
    }
  }
  function Ld(l, t, e) {
    t = St(e, t), t = Ac(l.stateNode, t, 2), l = oe(l, t, 2), l !== null && (Ya(l, 2), Ct(l));
  }
  function sl(l, t, e) {
    if (l.tag === 3)
      Ld(l, l, e);
    else
      for (; t !== null; ) {
        if (t.tag === 3) {
          Ld(
            t,
            l,
            e
          );
          break;
        } else if (t.tag === 1) {
          var a = t.stateNode;
          if (typeof t.type.getDerivedStateFromError == "function" || typeof a.componentDidCatch == "function" && (ye === null || !ye.has(a))) {
            l = St(e, l), e = Xo(2), a = oe(t, e, 2), a !== null && (Qo(
              e,
              a,
              t,
              l
            ), Ya(a, 2), Ct(a));
            break;
          }
        }
        t = t.return;
      }
  }
  function Jc(l, t, e) {
    var a = l.pingCache;
    if (a === null) {
      a = l.pingCache = new bh();
      var u = /* @__PURE__ */ new Set();
      a.set(t, u);
    } else
      u = a.get(t), u === void 0 && (u = /* @__PURE__ */ new Set(), a.set(t, u));
    u.has(e) || (Yc = !0, u.add(e), l = jh.bind(null, l, t, e), t.then(l, l));
  }
  function jh(l, t, e) {
    var a = l.pingCache;
    a !== null && a.delete(t), l.pingedLanes |= l.suspendedLanes & e, l.warmLanes &= ~e, vl === l && (P & e) === e && (Al === 4 || Al === 3 && (P & 62914560) === P && 300 > ut() - xn ? (nl & 2) === 0 && Na(l, 0) : Gc |= e, Ea === P && (Ea = 0)), Ct(l);
  }
  function Xd(l, t) {
    t === 0 && (t = Cf()), l = Ce(l, t), l !== null && (Ya(l, t), Ct(l));
  }
  function Eh(l) {
    var t = l.memoizedState, e = 0;
    t !== null && (e = t.retryLane), Xd(l, e);
  }
  function xh(l, t) {
    var e = 0;
    switch (l.tag) {
      case 31:
      case 13:
        var a = l.stateNode, u = l.memoizedState;
        u !== null && (e = u.retryLane);
        break;
      case 19:
        a = l.stateNode;
        break;
      case 22:
        a = l.stateNode._retryCache;
        break;
      default:
        throw Error(d(314));
    }
    a !== null && a.delete(t), Xd(l, e);
  }
  function Nh(l, t) {
    return ni(l, t);
  }
  var Rn = null, _a = null, wc = !1, Cn = !1, $c = !1, be = 0;
  function Ct(l) {
    l !== _a && l.next === null && (_a === null ? Rn = _a = l : _a = _a.next = l), Cn = !0, wc || (wc = !0, _h());
  }
  function Su(l, t) {
    if (!$c && Cn) {
      $c = !0;
      do
        for (var e = !1, a = Rn; a !== null; ) {
          if (l !== 0) {
            var u = a.pendingLanes;
            if (u === 0) var n = 0;
            else {
              var i = a.suspendedLanes, c = a.pingedLanes;
              n = (1 << 31 - it(42 | l) + 1) - 1, n &= u & ~(i & ~c), n = n & 201326741 ? n & 201326741 | 1 : n ? n | 2 : 0;
            }
            n !== 0 && (e = !0, Kd(a, n));
          } else
            n = P, n = Bu(
              a,
              a === vl ? n : 0,
              a.cancelPendingCommit !== null || a.timeoutHandle !== -1
            ), (n & 3) === 0 || Ba(a, n) || (e = !0, Kd(a, n));
          a = a.next;
        }
      while (e);
      $c = !1;
    }
  }
  function Oh() {
    Qd();
  }
  function Qd() {
    Cn = wc = !1;
    var l = 0;
    be !== 0 && Gh() && (l = be);
    for (var t = ut(), e = null, a = Rn; a !== null; ) {
      var u = a.next, n = Zd(a, t);
      n === 0 ? (a.next = null, e === null ? Rn = u : e.next = u, u === null && (_a = e)) : (e = a, (l !== 0 || (n & 3) !== 0) && (Cn = !0)), a = u;
    }
    Ul !== 0 && Ul !== 5 || Su(l), be !== 0 && (be = 0);
  }
  function Zd(l, t) {
    for (var e = l.suspendedLanes, a = l.pingedLanes, u = l.expirationTimes, n = l.pendingLanes & -62914561; 0 < n; ) {
      var i = 31 - it(n), c = 1 << i, s = u[i];
      s === -1 ? ((c & e) === 0 || (c & a) !== 0) && (u[i] = tm(c, t)) : s <= t && (l.expiredLanes |= c), n &= ~c;
    }
    if (t = vl, e = P, e = Bu(
      l,
      l === t ? e : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), a = l.callbackNode, e === 0 || l === t && (fl === 2 || fl === 9) || l.cancelPendingCommit !== null)
      return a !== null && a !== null && ii(a), l.callbackNode = null, l.callbackPriority = 0;
    if ((e & 3) === 0 || Ba(l, e)) {
      if (t = e & -e, t === l.callbackPriority) return t;
      switch (a !== null && ii(a), si(e)) {
        case 2:
        case 8:
          e = Uf;
          break;
        case 32:
          e = Ru;
          break;
        case 268435456:
          e = Rf;
          break;
        default:
          e = Ru;
      }
      return a = Vd.bind(null, l), e = ni(e, a), l.callbackPriority = t, l.callbackNode = e, t;
    }
    return a !== null && a !== null && ii(a), l.callbackPriority = 2, l.callbackNode = null, 2;
  }
  function Vd(l, t) {
    if (Ul !== 0 && Ul !== 5)
      return l.callbackNode = null, l.callbackPriority = 0, null;
    var e = l.callbackNode;
    if (Un() && l.callbackNode !== e)
      return null;
    var a = P;
    return a = Bu(
      l,
      l === vl ? a : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), a === 0 ? null : (Ed(l, a, t), Zd(l, ut()), l.callbackNode != null && l.callbackNode === e ? Vd.bind(null, l) : null);
  }
  function Kd(l, t) {
    if (Un()) return null;
    Ed(l, t, !0);
  }
  function _h() {
    Xh(function() {
      (nl & 6) !== 0 ? ni(
        Df,
        Oh
      ) : Qd();
    });
  }
  function Wc() {
    if (be === 0) {
      var l = ha;
      l === 0 && (l = Cu, Cu <<= 1, (Cu & 261888) === 0 && (Cu = 256)), be = l;
    }
    return be;
  }
  function Jd(l) {
    return l == null || typeof l == "symbol" || typeof l == "boolean" ? null : typeof l == "function" ? l : Xu("" + l);
  }
  function wd(l, t) {
    var e = t.ownerDocument.createElement("input");
    return e.name = t.name, e.value = t.value, l.id && e.setAttribute("form", l.id), t.parentNode.insertBefore(e, t), l = new FormData(l), e.parentNode.removeChild(e), l;
  }
  function Mh(l, t, e, a, u) {
    if (t === "submit" && e && e.stateNode === u) {
      var n = Jd(
        (u[Wl] || null).action
      ), i = a.submitter;
      i && (t = (t = i[Wl] || null) ? Jd(t.formAction) : i.getAttribute("formAction"), t !== null && (n = t, i = null));
      var c = new Ku(
        "action",
        "action",
        null,
        a,
        u
      );
      l.push({
        event: c,
        listeners: [
          {
            instance: null,
            listener: function() {
              if (a.defaultPrevented) {
                if (be !== 0) {
                  var s = i ? wd(u, i) : new FormData(u);
                  vc(
                    e,
                    {
                      pending: !0,
                      data: s,
                      method: u.method,
                      action: n
                    },
                    null,
                    s
                  );
                }
              } else
                typeof n == "function" && (c.preventDefault(), s = i ? wd(u, i) : new FormData(u), vc(
                  e,
                  {
                    pending: !0,
                    data: s,
                    method: u.method,
                    action: n
                  },
                  n,
                  s
                ));
            },
            currentTarget: u
          }
        ]
      });
    }
  }
  for (var kc = 0; kc < Ui.length; kc++) {
    var Fc = Ui[kc], Dh = Fc.toLowerCase(), Uh = Fc[0].toUpperCase() + Fc.slice(1);
    xt(
      Dh,
      "on" + Uh
    );
  }
  xt(Ts, "onAnimationEnd"), xt(js, "onAnimationIteration"), xt(Es, "onAnimationStart"), xt("dblclick", "onDoubleClick"), xt("focusin", "onFocus"), xt("focusout", "onBlur"), xt($m, "onTransitionRun"), xt(Wm, "onTransitionStart"), xt(km, "onTransitionCancel"), xt(xs, "onTransitionEnd"), la("onMouseEnter", ["mouseout", "mouseover"]), la("onMouseLeave", ["mouseout", "mouseover"]), la("onPointerEnter", ["pointerout", "pointerover"]), la("onPointerLeave", ["pointerout", "pointerover"]), Me(
    "onChange",
    "change click focusin focusout input keydown keyup selectionchange".split(" ")
  ), Me(
    "onSelect",
    "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(
      " "
    )
  ), Me("onBeforeInput", [
    "compositionend",
    "keypress",
    "textInput",
    "paste"
  ]), Me(
    "onCompositionEnd",
    "compositionend focusout keydown keypress keyup mousedown".split(" ")
  ), Me(
    "onCompositionStart",
    "compositionstart focusout keydown keypress keyup mousedown".split(" ")
  ), Me(
    "onCompositionUpdate",
    "compositionupdate focusout keydown keypress keyup mousedown".split(" ")
  );
  var bu = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
    " "
  ), Rh = new Set(
    "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(bu)
  );
  function $d(l, t) {
    t = (t & 4) !== 0;
    for (var e = 0; e < l.length; e++) {
      var a = l[e], u = a.event;
      a = a.listeners;
      l: {
        var n = void 0;
        if (t)
          for (var i = a.length - 1; 0 <= i; i--) {
            var c = a[i], s = c.instance, y = c.currentTarget;
            if (c = c.listener, s !== n && u.isPropagationStopped())
              break l;
            n = c, u.currentTarget = y;
            try {
              n(u);
            } catch (b) {
              $u(b);
            }
            u.currentTarget = null, n = s;
          }
        else
          for (i = 0; i < a.length; i++) {
            if (c = a[i], s = c.instance, y = c.currentTarget, c = c.listener, s !== n && u.isPropagationStopped())
              break l;
            n = c, u.currentTarget = y;
            try {
              n(u);
            } catch (b) {
              $u(b);
            }
            u.currentTarget = null, n = s;
          }
      }
    }
  }
  function I(l, t) {
    var e = t[oi];
    e === void 0 && (e = t[oi] = /* @__PURE__ */ new Set());
    var a = l + "__bubble";
    e.has(a) || (Wd(t, l, 2, !1), e.add(a));
  }
  function Ic(l, t, e) {
    var a = 0;
    t && (a |= 4), Wd(
      e,
      l,
      a,
      t
    );
  }
  var Hn = "_reactListening" + Math.random().toString(36).slice(2);
  function Pc(l) {
    if (!l[Hn]) {
      l[Hn] = !0, Xf.forEach(function(e) {
        e !== "selectionchange" && (Rh.has(e) || Ic(e, !1, l), Ic(e, !0, l));
      });
      var t = l.nodeType === 9 ? l : l.ownerDocument;
      t === null || t[Hn] || (t[Hn] = !0, Ic("selectionchange", !1, t));
    }
  }
  function Wd(l, t, e, a) {
    switch (jr(t)) {
      case 2:
        var u = cv;
        break;
      case 8:
        u = fv;
        break;
      default:
        u = vf;
    }
    e = u.bind(
      null,
      t,
      e,
      l
    ), u = void 0, !bi || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (u = !0), a ? u !== void 0 ? l.addEventListener(t, e, {
      capture: !0,
      passive: u
    }) : l.addEventListener(t, e, !0) : u !== void 0 ? l.addEventListener(t, e, {
      passive: u
    }) : l.addEventListener(t, e, !1);
  }
  function lf(l, t, e, a, u) {
    var n = a;
    if ((t & 1) === 0 && (t & 2) === 0 && a !== null)
      l: for (; ; ) {
        if (a === null) return;
        var i = a.tag;
        if (i === 3 || i === 4) {
          var c = a.stateNode.containerInfo;
          if (c === u) break;
          if (i === 4)
            for (i = a.return; i !== null; ) {
              var s = i.tag;
              if ((s === 3 || s === 4) && i.stateNode.containerInfo === u)
                return;
              i = i.return;
            }
          for (; c !== null; ) {
            if (i = Fe(c), i === null) return;
            if (s = i.tag, s === 5 || s === 6 || s === 26 || s === 27) {
              a = n = i;
              continue l;
            }
            c = c.parentNode;
          }
        }
        a = a.return;
      }
    Pf(function() {
      var y = n, b = gi(e), j = [];
      l: {
        var g = Ns.get(l);
        if (g !== void 0) {
          var S = Ku, H = l;
          switch (l) {
            case "keypress":
              if (Zu(e) === 0) break l;
            case "keydown":
            case "keyup":
              S = xm;
              break;
            case "focusin":
              H = "focus", S = Ti;
              break;
            case "focusout":
              H = "blur", S = Ti;
              break;
            case "beforeblur":
            case "afterblur":
              S = Ti;
              break;
            case "click":
              if (e.button === 2) break l;
            case "auxclick":
            case "dblclick":
            case "mousedown":
            case "mousemove":
            case "mouseup":
            case "mouseout":
            case "mouseover":
            case "contextmenu":
              S = es;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              S = hm;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              S = _m;
              break;
            case Ts:
            case js:
            case Es:
              S = gm;
              break;
            case xs:
              S = Dm;
              break;
            case "scroll":
            case "scrollend":
              S = rm;
              break;
            case "wheel":
              S = Rm;
              break;
            case "copy":
            case "cut":
            case "paste":
              S = bm;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              S = us;
              break;
            case "toggle":
            case "beforetoggle":
              S = Hm;
          }
          var L = (t & 4) !== 0, ml = !L && (l === "scroll" || l === "scrollend"), h = L ? g !== null ? g + "Capture" : null : g;
          L = [];
          for (var o = y, v; o !== null; ) {
            var T = o;
            if (v = T.stateNode, T = T.tag, T !== 5 && T !== 26 && T !== 27 || v === null || h === null || (T = Xa(o, h), T != null && L.push(
              pu(o, T, v)
            )), ml) break;
            o = o.return;
          }
          0 < L.length && (g = new S(
            g,
            H,
            null,
            e,
            b
          ), j.push({ event: g, listeners: L }));
        }
      }
      if ((t & 7) === 0) {
        l: {
          if (g = l === "mouseover" || l === "pointerover", S = l === "mouseout" || l === "pointerout", g && e !== yi && (H = e.relatedTarget || e.fromElement) && (Fe(H) || H[ke]))
            break l;
          if ((S || g) && (g = b.window === b ? b : (g = b.ownerDocument) ? g.defaultView || g.parentWindow : window, S ? (H = e.relatedTarget || e.toElement, S = y, H = H ? Fe(H) : null, H !== null && (ml = M(H), L = H.tag, H !== ml || L !== 5 && L !== 27 && L !== 6) && (H = null)) : (S = null, H = y), S !== H)) {
            if (L = es, T = "onMouseLeave", h = "onMouseEnter", o = "mouse", (l === "pointerout" || l === "pointerover") && (L = us, T = "onPointerLeave", h = "onPointerEnter", o = "pointer"), ml = S == null ? g : La(S), v = H == null ? g : La(H), g = new L(
              T,
              o + "leave",
              S,
              e,
              b
            ), g.target = ml, g.relatedTarget = v, T = null, Fe(b) === y && (L = new L(
              h,
              o + "enter",
              H,
              e,
              b
            ), L.target = v, L.relatedTarget = ml, T = L), ml = T, S && H)
              t: {
                for (L = Ch, h = S, o = H, v = 0, T = h; T; T = L(T))
                  v++;
                T = 0;
                for (var G = o; G; G = L(G))
                  T++;
                for (; 0 < v - T; )
                  h = L(h), v--;
                for (; 0 < T - v; )
                  o = L(o), T--;
                for (; v--; ) {
                  if (h === o || o !== null && h === o.alternate) {
                    L = h;
                    break t;
                  }
                  h = L(h), o = L(o);
                }
                L = null;
              }
            else L = null;
            S !== null && kd(
              j,
              g,
              S,
              L,
              !1
            ), H !== null && ml !== null && kd(
              j,
              ml,
              H,
              L,
              !0
            );
          }
        }
        l: {
          if (g = y ? La(y) : window, S = g.nodeName && g.nodeName.toLowerCase(), S === "select" || S === "input" && g.type === "file")
            var al = rs;
          else if (os(g))
            if (ms)
              al = Km;
            else {
              al = Zm;
              var B = Qm;
            }
          else
            S = g.nodeName, !S || S.toLowerCase() !== "input" || g.type !== "checkbox" && g.type !== "radio" ? y && vi(y.elementType) && (al = rs) : al = Vm;
          if (al && (al = al(l, y))) {
            ds(
              j,
              al,
              e,
              b
            );
            break l;
          }
          B && B(l, g, y), l === "focusout" && y && g.type === "number" && y.memoizedProps.value != null && hi(g, "number", g.value);
        }
        switch (B = y ? La(y) : window, l) {
          case "focusin":
            (os(B) || B.contentEditable === "true") && (ia = B, _i = y, Wa = null);
            break;
          case "focusout":
            Wa = _i = ia = null;
            break;
          case "mousedown":
            Mi = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            Mi = !1, As(j, e, b);
            break;
          case "selectionchange":
            if (wm) break;
          case "keydown":
          case "keyup":
            As(j, e, b);
        }
        var W;
        if (Ei)
          l: {
            switch (l) {
              case "compositionstart":
                var ll = "onCompositionStart";
                break l;
              case "compositionend":
                ll = "onCompositionEnd";
                break l;
              case "compositionupdate":
                ll = "onCompositionUpdate";
                break l;
            }
            ll = void 0;
          }
        else
          na ? fs(l, e) && (ll = "onCompositionEnd") : l === "keydown" && e.keyCode === 229 && (ll = "onCompositionStart");
        ll && (ns && e.locale !== "ko" && (na || ll !== "onCompositionStart" ? ll === "onCompositionEnd" && na && (W = ls()) : (ae = b, pi = "value" in ae ? ae.value : ae.textContent, na = !0)), B = qn(y, ll), 0 < B.length && (ll = new as(
          ll,
          l,
          null,
          e,
          b
        ), j.push({ event: ll, listeners: B }), W ? ll.data = W : (W = ss(e), W !== null && (ll.data = W)))), (W = Bm ? Ym(l, e) : Gm(l, e)) && (ll = qn(y, "onBeforeInput"), 0 < ll.length && (B = new as(
          "onBeforeInput",
          "beforeinput",
          null,
          e,
          b
        ), j.push({
          event: B,
          listeners: ll
        }), B.data = W)), Mh(
          j,
          l,
          y,
          e,
          b
        );
      }
      $d(j, t);
    });
  }
  function pu(l, t, e) {
    return {
      instance: l,
      listener: t,
      currentTarget: e
    };
  }
  function qn(l, t) {
    for (var e = t + "Capture", a = []; l !== null; ) {
      var u = l, n = u.stateNode;
      if (u = u.tag, u !== 5 && u !== 26 && u !== 27 || n === null || (u = Xa(l, e), u != null && a.unshift(
        pu(l, u, n)
      ), u = Xa(l, t), u != null && a.push(
        pu(l, u, n)
      )), l.tag === 3) return a;
      l = l.return;
    }
    return [];
  }
  function Ch(l) {
    if (l === null) return null;
    do
      l = l.return;
    while (l && l.tag !== 5 && l.tag !== 27);
    return l || null;
  }
  function kd(l, t, e, a, u) {
    for (var n = t._reactName, i = []; e !== null && e !== a; ) {
      var c = e, s = c.alternate, y = c.stateNode;
      if (c = c.tag, s !== null && s === a) break;
      c !== 5 && c !== 26 && c !== 27 || y === null || (s = y, u ? (y = Xa(e, n), y != null && i.unshift(
        pu(e, y, s)
      )) : u || (y = Xa(e, n), y != null && i.push(
        pu(e, y, s)
      ))), e = e.return;
    }
    i.length !== 0 && l.push({ event: t, listeners: i });
  }
  var Hh = /\r\n?/g, qh = /\u0000|\uFFFD/g;
  function Fd(l) {
    return (typeof l == "string" ? l : "" + l).replace(Hh, `
`).replace(qh, "");
  }
  function Id(l, t) {
    return t = Fd(t), Fd(l) === t;
  }
  function rl(l, t, e, a, u, n) {
    switch (e) {
      case "children":
        typeof a == "string" ? t === "body" || t === "textarea" && a === "" || ea(l, a) : (typeof a == "number" || typeof a == "bigint") && t !== "body" && ea(l, "" + a);
        break;
      case "className":
        Gu(l, "class", a);
        break;
      case "tabIndex":
        Gu(l, "tabindex", a);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        Gu(l, e, a);
        break;
      case "style":
        Ff(l, a, n);
        break;
      case "data":
        if (t !== "object") {
          Gu(l, "data", a);
          break;
        }
      case "src":
      case "href":
        if (a === "" && (t !== "a" || e !== "href")) {
          l.removeAttribute(e);
          break;
        }
        if (a == null || typeof a == "function" || typeof a == "symbol" || typeof a == "boolean") {
          l.removeAttribute(e);
          break;
        }
        a = Xu("" + a), l.setAttribute(e, a);
        break;
      case "action":
      case "formAction":
        if (typeof a == "function") {
          l.setAttribute(
            e,
            "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')"
          );
          break;
        } else
          typeof n == "function" && (e === "formAction" ? (t !== "input" && rl(l, t, "name", u.name, u, null), rl(
            l,
            t,
            "formEncType",
            u.formEncType,
            u,
            null
          ), rl(
            l,
            t,
            "formMethod",
            u.formMethod,
            u,
            null
          ), rl(
            l,
            t,
            "formTarget",
            u.formTarget,
            u,
            null
          )) : (rl(l, t, "encType", u.encType, u, null), rl(l, t, "method", u.method, u, null), rl(l, t, "target", u.target, u, null)));
        if (a == null || typeof a == "symbol" || typeof a == "boolean") {
          l.removeAttribute(e);
          break;
        }
        a = Xu("" + a), l.setAttribute(e, a);
        break;
      case "onClick":
        a != null && (l.onclick = Bt);
        break;
      case "onScroll":
        a != null && I("scroll", l);
        break;
      case "onScrollEnd":
        a != null && I("scrollend", l);
        break;
      case "dangerouslySetInnerHTML":
        if (a != null) {
          if (typeof a != "object" || !("__html" in a))
            throw Error(d(61));
          if (e = a.__html, e != null) {
            if (u.children != null) throw Error(d(60));
            l.innerHTML = e;
          }
        }
        break;
      case "multiple":
        l.multiple = a && typeof a != "function" && typeof a != "symbol";
        break;
      case "muted":
        l.muted = a && typeof a != "function" && typeof a != "symbol";
        break;
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "defaultValue":
      case "defaultChecked":
      case "innerHTML":
      case "ref":
        break;
      case "autoFocus":
        break;
      case "xlinkHref":
        if (a == null || typeof a == "function" || typeof a == "boolean" || typeof a == "symbol") {
          l.removeAttribute("xlink:href");
          break;
        }
        e = Xu("" + a), l.setAttributeNS(
          "http://www.w3.org/1999/xlink",
          "xlink:href",
          e
        );
        break;
      case "contentEditable":
      case "spellCheck":
      case "draggable":
      case "value":
      case "autoReverse":
      case "externalResourcesRequired":
      case "focusable":
      case "preserveAlpha":
        a != null && typeof a != "function" && typeof a != "symbol" ? l.setAttribute(e, "" + a) : l.removeAttribute(e);
        break;
      case "inert":
      case "allowFullScreen":
      case "async":
      case "autoPlay":
      case "controls":
      case "default":
      case "defer":
      case "disabled":
      case "disablePictureInPicture":
      case "disableRemotePlayback":
      case "formNoValidate":
      case "hidden":
      case "loop":
      case "noModule":
      case "noValidate":
      case "open":
      case "playsInline":
      case "readOnly":
      case "required":
      case "reversed":
      case "scoped":
      case "seamless":
      case "itemScope":
        a && typeof a != "function" && typeof a != "symbol" ? l.setAttribute(e, "") : l.removeAttribute(e);
        break;
      case "capture":
      case "download":
        a === !0 ? l.setAttribute(e, "") : a !== !1 && a != null && typeof a != "function" && typeof a != "symbol" ? l.setAttribute(e, a) : l.removeAttribute(e);
        break;
      case "cols":
      case "rows":
      case "size":
      case "span":
        a != null && typeof a != "function" && typeof a != "symbol" && !isNaN(a) && 1 <= a ? l.setAttribute(e, a) : l.removeAttribute(e);
        break;
      case "rowSpan":
      case "start":
        a == null || typeof a == "function" || typeof a == "symbol" || isNaN(a) ? l.removeAttribute(e) : l.setAttribute(e, a);
        break;
      case "popover":
        I("beforetoggle", l), I("toggle", l), Yu(l, "popover", a);
        break;
      case "xlinkActuate":
        qt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:actuate",
          a
        );
        break;
      case "xlinkArcrole":
        qt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:arcrole",
          a
        );
        break;
      case "xlinkRole":
        qt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:role",
          a
        );
        break;
      case "xlinkShow":
        qt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:show",
          a
        );
        break;
      case "xlinkTitle":
        qt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:title",
          a
        );
        break;
      case "xlinkType":
        qt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:type",
          a
        );
        break;
      case "xmlBase":
        qt(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:base",
          a
        );
        break;
      case "xmlLang":
        qt(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:lang",
          a
        );
        break;
      case "xmlSpace":
        qt(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:space",
          a
        );
        break;
      case "is":
        Yu(l, "is", a);
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        (!(2 < e.length) || e[0] !== "o" && e[0] !== "O" || e[1] !== "n" && e[1] !== "N") && (e = om.get(e) || e, Yu(l, e, a));
    }
  }
  function tf(l, t, e, a, u, n) {
    switch (e) {
      case "style":
        Ff(l, a, n);
        break;
      case "dangerouslySetInnerHTML":
        if (a != null) {
          if (typeof a != "object" || !("__html" in a))
            throw Error(d(61));
          if (e = a.__html, e != null) {
            if (u.children != null) throw Error(d(60));
            l.innerHTML = e;
          }
        }
        break;
      case "children":
        typeof a == "string" ? ea(l, a) : (typeof a == "number" || typeof a == "bigint") && ea(l, "" + a);
        break;
      case "onScroll":
        a != null && I("scroll", l);
        break;
      case "onScrollEnd":
        a != null && I("scrollend", l);
        break;
      case "onClick":
        a != null && (l.onclick = Bt);
        break;
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "innerHTML":
      case "ref":
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        if (!Qf.hasOwnProperty(e))
          l: {
            if (e[0] === "o" && e[1] === "n" && (u = e.endsWith("Capture"), t = e.slice(2, u ? e.length - 7 : void 0), n = l[Wl] || null, n = n != null ? n[e] : null, typeof n == "function" && l.removeEventListener(t, n, u), typeof a == "function")) {
              typeof n != "function" && n !== null && (e in l ? l[e] = null : l.hasAttribute(e) && l.removeAttribute(e)), l.addEventListener(t, a, u);
              break l;
            }
            e in l ? l[e] = a : a === !0 ? l.setAttribute(e, "") : Yu(l, e, a);
          }
    }
  }
  function Xl(l, t, e) {
    switch (t) {
      case "div":
      case "span":
      case "svg":
      case "path":
      case "a":
      case "g":
      case "p":
      case "li":
        break;
      case "img":
        I("error", l), I("load", l);
        var a = !1, u = !1, n;
        for (n in e)
          if (e.hasOwnProperty(n)) {
            var i = e[n];
            if (i != null)
              switch (n) {
                case "src":
                  a = !0;
                  break;
                case "srcSet":
                  u = !0;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(d(137, t));
                default:
                  rl(l, t, n, i, e, null);
              }
          }
        u && rl(l, t, "srcSet", e.srcSet, e, null), a && rl(l, t, "src", e.src, e, null);
        return;
      case "input":
        I("invalid", l);
        var c = n = i = u = null, s = null, y = null;
        for (a in e)
          if (e.hasOwnProperty(a)) {
            var b = e[a];
            if (b != null)
              switch (a) {
                case "name":
                  u = b;
                  break;
                case "type":
                  i = b;
                  break;
                case "checked":
                  s = b;
                  break;
                case "defaultChecked":
                  y = b;
                  break;
                case "value":
                  n = b;
                  break;
                case "defaultValue":
                  c = b;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  if (b != null)
                    throw Error(d(137, t));
                  break;
                default:
                  rl(l, t, a, b, e, null);
              }
          }
        wf(
          l,
          n,
          c,
          s,
          y,
          i,
          u,
          !1
        );
        return;
      case "select":
        I("invalid", l), a = i = n = null;
        for (u in e)
          if (e.hasOwnProperty(u) && (c = e[u], c != null))
            switch (u) {
              case "value":
                n = c;
                break;
              case "defaultValue":
                i = c;
                break;
              case "multiple":
                a = c;
              default:
                rl(l, t, u, c, e, null);
            }
        t = n, e = i, l.multiple = !!a, t != null ? ta(l, !!a, t, !1) : e != null && ta(l, !!a, e, !0);
        return;
      case "textarea":
        I("invalid", l), n = u = a = null;
        for (i in e)
          if (e.hasOwnProperty(i) && (c = e[i], c != null))
            switch (i) {
              case "value":
                a = c;
                break;
              case "defaultValue":
                u = c;
                break;
              case "children":
                n = c;
                break;
              case "dangerouslySetInnerHTML":
                if (c != null) throw Error(d(91));
                break;
              default:
                rl(l, t, i, c, e, null);
            }
        Wf(l, a, u, n);
        return;
      case "option":
        for (s in e)
          e.hasOwnProperty(s) && (a = e[s], a != null) && (s === "selected" ? l.selected = a && typeof a != "function" && typeof a != "symbol" : rl(l, t, s, a, e, null));
        return;
      case "dialog":
        I("beforetoggle", l), I("toggle", l), I("cancel", l), I("close", l);
        break;
      case "iframe":
      case "object":
        I("load", l);
        break;
      case "video":
      case "audio":
        for (a = 0; a < bu.length; a++)
          I(bu[a], l);
        break;
      case "image":
        I("error", l), I("load", l);
        break;
      case "details":
        I("toggle", l);
        break;
      case "embed":
      case "source":
      case "link":
        I("error", l), I("load", l);
      case "area":
      case "base":
      case "br":
      case "col":
      case "hr":
      case "keygen":
      case "meta":
      case "param":
      case "track":
      case "wbr":
      case "menuitem":
        for (y in e)
          if (e.hasOwnProperty(y) && (a = e[y], a != null))
            switch (y) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(d(137, t));
              default:
                rl(l, t, y, a, e, null);
            }
        return;
      default:
        if (vi(t)) {
          for (b in e)
            e.hasOwnProperty(b) && (a = e[b], a !== void 0 && tf(
              l,
              t,
              b,
              a,
              e,
              void 0
            ));
          return;
        }
    }
    for (c in e)
      e.hasOwnProperty(c) && (a = e[c], a != null && rl(l, t, c, a, e, null));
  }
  function Bh(l, t, e, a) {
    switch (t) {
      case "div":
      case "span":
      case "svg":
      case "path":
      case "a":
      case "g":
      case "p":
      case "li":
        break;
      case "input":
        var u = null, n = null, i = null, c = null, s = null, y = null, b = null;
        for (S in e) {
          var j = e[S];
          if (e.hasOwnProperty(S) && j != null)
            switch (S) {
              case "checked":
                break;
              case "value":
                break;
              case "defaultValue":
                s = j;
              default:
                a.hasOwnProperty(S) || rl(l, t, S, null, a, j);
            }
        }
        for (var g in a) {
          var S = a[g];
          if (j = e[g], a.hasOwnProperty(g) && (S != null || j != null))
            switch (g) {
              case "type":
                n = S;
                break;
              case "name":
                u = S;
                break;
              case "checked":
                y = S;
                break;
              case "defaultChecked":
                b = S;
                break;
              case "value":
                i = S;
                break;
              case "defaultValue":
                c = S;
                break;
              case "children":
              case "dangerouslySetInnerHTML":
                if (S != null)
                  throw Error(d(137, t));
                break;
              default:
                S !== j && rl(
                  l,
                  t,
                  g,
                  S,
                  a,
                  j
                );
            }
        }
        mi(
          l,
          i,
          c,
          s,
          y,
          b,
          n,
          u
        );
        return;
      case "select":
        S = i = c = g = null;
        for (n in e)
          if (s = e[n], e.hasOwnProperty(n) && s != null)
            switch (n) {
              case "value":
                break;
              case "multiple":
                S = s;
              default:
                a.hasOwnProperty(n) || rl(
                  l,
                  t,
                  n,
                  null,
                  a,
                  s
                );
            }
        for (u in a)
          if (n = a[u], s = e[u], a.hasOwnProperty(u) && (n != null || s != null))
            switch (u) {
              case "value":
                g = n;
                break;
              case "defaultValue":
                c = n;
                break;
              case "multiple":
                i = n;
              default:
                n !== s && rl(
                  l,
                  t,
                  u,
                  n,
                  a,
                  s
                );
            }
        t = c, e = i, a = S, g != null ? ta(l, !!e, g, !1) : !!a != !!e && (t != null ? ta(l, !!e, t, !0) : ta(l, !!e, e ? [] : "", !1));
        return;
      case "textarea":
        S = g = null;
        for (c in e)
          if (u = e[c], e.hasOwnProperty(c) && u != null && !a.hasOwnProperty(c))
            switch (c) {
              case "value":
                break;
              case "children":
                break;
              default:
                rl(l, t, c, null, a, u);
            }
        for (i in a)
          if (u = a[i], n = e[i], a.hasOwnProperty(i) && (u != null || n != null))
            switch (i) {
              case "value":
                g = u;
                break;
              case "defaultValue":
                S = u;
                break;
              case "children":
                break;
              case "dangerouslySetInnerHTML":
                if (u != null) throw Error(d(91));
                break;
              default:
                u !== n && rl(l, t, i, u, a, n);
            }
        $f(l, g, S);
        return;
      case "option":
        for (var H in e)
          g = e[H], e.hasOwnProperty(H) && g != null && !a.hasOwnProperty(H) && (H === "selected" ? l.selected = !1 : rl(
            l,
            t,
            H,
            null,
            a,
            g
          ));
        for (s in a)
          g = a[s], S = e[s], a.hasOwnProperty(s) && g !== S && (g != null || S != null) && (s === "selected" ? l.selected = g && typeof g != "function" && typeof g != "symbol" : rl(
            l,
            t,
            s,
            g,
            a,
            S
          ));
        return;
      case "img":
      case "link":
      case "area":
      case "base":
      case "br":
      case "col":
      case "embed":
      case "hr":
      case "keygen":
      case "meta":
      case "param":
      case "source":
      case "track":
      case "wbr":
      case "menuitem":
        for (var L in e)
          g = e[L], e.hasOwnProperty(L) && g != null && !a.hasOwnProperty(L) && rl(l, t, L, null, a, g);
        for (y in a)
          if (g = a[y], S = e[y], a.hasOwnProperty(y) && g !== S && (g != null || S != null))
            switch (y) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (g != null)
                  throw Error(d(137, t));
                break;
              default:
                rl(
                  l,
                  t,
                  y,
                  g,
                  a,
                  S
                );
            }
        return;
      default:
        if (vi(t)) {
          for (var ml in e)
            g = e[ml], e.hasOwnProperty(ml) && g !== void 0 && !a.hasOwnProperty(ml) && tf(
              l,
              t,
              ml,
              void 0,
              a,
              g
            );
          for (b in a)
            g = a[b], S = e[b], !a.hasOwnProperty(b) || g === S || g === void 0 && S === void 0 || tf(
              l,
              t,
              b,
              g,
              a,
              S
            );
          return;
        }
    }
    for (var h in e)
      g = e[h], e.hasOwnProperty(h) && g != null && !a.hasOwnProperty(h) && rl(l, t, h, null, a, g);
    for (j in a)
      g = a[j], S = e[j], !a.hasOwnProperty(j) || g === S || g == null && S == null || rl(l, t, j, g, a, S);
  }
  function Pd(l) {
    switch (l) {
      case "css":
      case "script":
      case "font":
      case "img":
      case "image":
      case "input":
      case "link":
        return !0;
      default:
        return !1;
    }
  }
  function Yh() {
    if (typeof performance.getEntriesByType == "function") {
      for (var l = 0, t = 0, e = performance.getEntriesByType("resource"), a = 0; a < e.length; a++) {
        var u = e[a], n = u.transferSize, i = u.initiatorType, c = u.duration;
        if (n && c && Pd(i)) {
          for (i = 0, c = u.responseEnd, a += 1; a < e.length; a++) {
            var s = e[a], y = s.startTime;
            if (y > c) break;
            var b = s.transferSize, j = s.initiatorType;
            b && Pd(j) && (s = s.responseEnd, i += b * (s < c ? 1 : (c - y) / (s - y)));
          }
          if (--a, t += 8 * (n + i) / (u.duration / 1e3), l++, 10 < l) break;
        }
      }
      if (0 < l) return t / l / 1e6;
    }
    return navigator.connection && (l = navigator.connection.downlink, typeof l == "number") ? l : 5;
  }
  var ef = null, af = null;
  function Bn(l) {
    return l.nodeType === 9 ? l : l.ownerDocument;
  }
  function lr(l) {
    switch (l) {
      case "http://www.w3.org/2000/svg":
        return 1;
      case "http://www.w3.org/1998/Math/MathML":
        return 2;
      default:
        return 0;
    }
  }
  function tr(l, t) {
    if (l === 0)
      switch (t) {
        case "svg":
          return 1;
        case "math":
          return 2;
        default:
          return 0;
      }
    return l === 1 && t === "foreignObject" ? 0 : l;
  }
  function uf(l, t) {
    return l === "textarea" || l === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.children == "bigint" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
  }
  var nf = null;
  function Gh() {
    var l = window.event;
    return l && l.type === "popstate" ? l === nf ? !1 : (nf = l, !0) : (nf = null, !1);
  }
  var er = typeof setTimeout == "function" ? setTimeout : void 0, Lh = typeof clearTimeout == "function" ? clearTimeout : void 0, ar = typeof Promise == "function" ? Promise : void 0, Xh = typeof queueMicrotask == "function" ? queueMicrotask : typeof ar < "u" ? function(l) {
    return ar.resolve(null).then(l).catch(Qh);
  } : er;
  function Qh(l) {
    setTimeout(function() {
      throw l;
    });
  }
  function pe(l) {
    return l === "head";
  }
  function ur(l, t) {
    var e = t, a = 0;
    do {
      var u = e.nextSibling;
      if (l.removeChild(e), u && u.nodeType === 8)
        if (e = u.data, e === "/$" || e === "/&") {
          if (a === 0) {
            l.removeChild(u), Ra(t);
            return;
          }
          a--;
        } else if (e === "$" || e === "$?" || e === "$~" || e === "$!" || e === "&")
          a++;
        else if (e === "html")
          Au(l.ownerDocument.documentElement);
        else if (e === "head") {
          e = l.ownerDocument.head, Au(e);
          for (var n = e.firstChild; n; ) {
            var i = n.nextSibling, c = n.nodeName;
            n[Ga] || c === "SCRIPT" || c === "STYLE" || c === "LINK" && n.rel.toLowerCase() === "stylesheet" || e.removeChild(n), n = i;
          }
        } else
          e === "body" && Au(l.ownerDocument.body);
      e = u;
    } while (e);
    Ra(t);
  }
  function nr(l, t) {
    var e = l;
    l = 0;
    do {
      var a = e.nextSibling;
      if (e.nodeType === 1 ? t ? (e._stashedDisplay = e.style.display, e.style.display = "none") : (e.style.display = e._stashedDisplay || "", e.getAttribute("style") === "" && e.removeAttribute("style")) : e.nodeType === 3 && (t ? (e._stashedText = e.nodeValue, e.nodeValue = "") : e.nodeValue = e._stashedText || ""), a && a.nodeType === 8)
        if (e = a.data, e === "/$") {
          if (l === 0) break;
          l--;
        } else
          e !== "$" && e !== "$?" && e !== "$~" && e !== "$!" || l++;
      e = a;
    } while (e);
  }
  function cf(l) {
    var t = l.firstChild;
    for (t && t.nodeType === 10 && (t = t.nextSibling); t; ) {
      var e = t;
      switch (t = t.nextSibling, e.nodeName) {
        case "HTML":
        case "HEAD":
        case "BODY":
          cf(e), di(e);
          continue;
        case "SCRIPT":
        case "STYLE":
          continue;
        case "LINK":
          if (e.rel.toLowerCase() === "stylesheet") continue;
      }
      l.removeChild(e);
    }
  }
  function Zh(l, t, e, a) {
    for (; l.nodeType === 1; ) {
      var u = e;
      if (l.nodeName.toLowerCase() !== t.toLowerCase()) {
        if (!a && (l.nodeName !== "INPUT" || l.type !== "hidden"))
          break;
      } else if (a) {
        if (!l[Ga])
          switch (t) {
            case "meta":
              if (!l.hasAttribute("itemprop")) break;
              return l;
            case "link":
              if (n = l.getAttribute("rel"), n === "stylesheet" && l.hasAttribute("data-precedence"))
                break;
              if (n !== u.rel || l.getAttribute("href") !== (u.href == null || u.href === "" ? null : u.href) || l.getAttribute("crossorigin") !== (u.crossOrigin == null ? null : u.crossOrigin) || l.getAttribute("title") !== (u.title == null ? null : u.title))
                break;
              return l;
            case "style":
              if (l.hasAttribute("data-precedence")) break;
              return l;
            case "script":
              if (n = l.getAttribute("src"), (n !== (u.src == null ? null : u.src) || l.getAttribute("type") !== (u.type == null ? null : u.type) || l.getAttribute("crossorigin") !== (u.crossOrigin == null ? null : u.crossOrigin)) && n && l.hasAttribute("async") && !l.hasAttribute("itemprop"))
                break;
              return l;
            default:
              return l;
          }
      } else if (t === "input" && l.type === "hidden") {
        var n = u.name == null ? null : "" + u.name;
        if (u.type === "hidden" && l.getAttribute("name") === n)
          return l;
      } else return l;
      if (l = Tt(l.nextSibling), l === null) break;
    }
    return null;
  }
  function Vh(l, t, e) {
    if (t === "") return null;
    for (; l.nodeType !== 3; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !e || (l = Tt(l.nextSibling), l === null)) return null;
    return l;
  }
  function ir(l, t) {
    for (; l.nodeType !== 8; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !t || (l = Tt(l.nextSibling), l === null)) return null;
    return l;
  }
  function ff(l) {
    return l.data === "$?" || l.data === "$~";
  }
  function sf(l) {
    return l.data === "$!" || l.data === "$?" && l.ownerDocument.readyState !== "loading";
  }
  function Kh(l, t) {
    var e = l.ownerDocument;
    if (l.data === "$~") l._reactRetry = t;
    else if (l.data !== "$?" || e.readyState !== "loading")
      t();
    else {
      var a = function() {
        t(), e.removeEventListener("DOMContentLoaded", a);
      };
      e.addEventListener("DOMContentLoaded", a), l._reactRetry = a;
    }
  }
  function Tt(l) {
    for (; l != null; l = l.nextSibling) {
      var t = l.nodeType;
      if (t === 1 || t === 3) break;
      if (t === 8) {
        if (t = l.data, t === "$" || t === "$!" || t === "$?" || t === "$~" || t === "&" || t === "F!" || t === "F")
          break;
        if (t === "/$" || t === "/&") return null;
      }
    }
    return l;
  }
  var of = null;
  function cr(l) {
    l = l.nextSibling;
    for (var t = 0; l; ) {
      if (l.nodeType === 8) {
        var e = l.data;
        if (e === "/$" || e === "/&") {
          if (t === 0)
            return Tt(l.nextSibling);
          t--;
        } else
          e !== "$" && e !== "$!" && e !== "$?" && e !== "$~" && e !== "&" || t++;
      }
      l = l.nextSibling;
    }
    return null;
  }
  function fr(l) {
    l = l.previousSibling;
    for (var t = 0; l; ) {
      if (l.nodeType === 8) {
        var e = l.data;
        if (e === "$" || e === "$!" || e === "$?" || e === "$~" || e === "&") {
          if (t === 0) return l;
          t--;
        } else e !== "/$" && e !== "/&" || t++;
      }
      l = l.previousSibling;
    }
    return null;
  }
  function sr(l, t, e) {
    switch (t = Bn(e), l) {
      case "html":
        if (l = t.documentElement, !l) throw Error(d(452));
        return l;
      case "head":
        if (l = t.head, !l) throw Error(d(453));
        return l;
      case "body":
        if (l = t.body, !l) throw Error(d(454));
        return l;
      default:
        throw Error(d(451));
    }
  }
  function Au(l) {
    for (var t = l.attributes; t.length; )
      l.removeAttributeNode(t[0]);
    di(l);
  }
  var jt = /* @__PURE__ */ new Map(), or = /* @__PURE__ */ new Set();
  function Yn(l) {
    return typeof l.getRootNode == "function" ? l.getRootNode() : l.nodeType === 9 ? l : l.ownerDocument;
  }
  var Pt = U.d;
  U.d = {
    f: Jh,
    r: wh,
    D: $h,
    C: Wh,
    L: kh,
    m: Fh,
    X: Ph,
    S: Ih,
    M: lv
  };
  function Jh() {
    var l = Pt.f(), t = _n();
    return l || t;
  }
  function wh(l) {
    var t = Ie(l);
    t !== null && t.tag === 5 && t.type === "form" ? No(t) : Pt.r(l);
  }
  var Ma = typeof document > "u" ? null : document;
  function dr(l, t, e) {
    var a = Ma;
    if (a && typeof t == "string" && t) {
      var u = yt(t);
      u = 'link[rel="' + l + '"][href="' + u + '"]', typeof e == "string" && (u += '[crossorigin="' + e + '"]'), or.has(u) || (or.add(u), l = { rel: l, crossOrigin: e, href: t }, a.querySelector(u) === null && (t = a.createElement("link"), Xl(t, "link", l), Hl(t), a.head.appendChild(t)));
    }
  }
  function $h(l) {
    Pt.D(l), dr("dns-prefetch", l, null);
  }
  function Wh(l, t) {
    Pt.C(l, t), dr("preconnect", l, t);
  }
  function kh(l, t, e) {
    Pt.L(l, t, e);
    var a = Ma;
    if (a && l && t) {
      var u = 'link[rel="preload"][as="' + yt(t) + '"]';
      t === "image" && e && e.imageSrcSet ? (u += '[imagesrcset="' + yt(
        e.imageSrcSet
      ) + '"]', typeof e.imageSizes == "string" && (u += '[imagesizes="' + yt(
        e.imageSizes
      ) + '"]')) : u += '[href="' + yt(l) + '"]';
      var n = u;
      switch (t) {
        case "style":
          n = Da(l);
          break;
        case "script":
          n = Ua(l);
      }
      jt.has(n) || (l = p(
        {
          rel: "preload",
          href: t === "image" && e && e.imageSrcSet ? void 0 : l,
          as: t
        },
        e
      ), jt.set(n, l), a.querySelector(u) !== null || t === "style" && a.querySelector(zu(n)) || t === "script" && a.querySelector(Tu(n)) || (t = a.createElement("link"), Xl(t, "link", l), Hl(t), a.head.appendChild(t)));
    }
  }
  function Fh(l, t) {
    Pt.m(l, t);
    var e = Ma;
    if (e && l) {
      var a = t && typeof t.as == "string" ? t.as : "script", u = 'link[rel="modulepreload"][as="' + yt(a) + '"][href="' + yt(l) + '"]', n = u;
      switch (a) {
        case "audioworklet":
        case "paintworklet":
        case "serviceworker":
        case "sharedworker":
        case "worker":
        case "script":
          n = Ua(l);
      }
      if (!jt.has(n) && (l = p({ rel: "modulepreload", href: l }, t), jt.set(n, l), e.querySelector(u) === null)) {
        switch (a) {
          case "audioworklet":
          case "paintworklet":
          case "serviceworker":
          case "sharedworker":
          case "worker":
          case "script":
            if (e.querySelector(Tu(n)))
              return;
        }
        a = e.createElement("link"), Xl(a, "link", l), Hl(a), e.head.appendChild(a);
      }
    }
  }
  function Ih(l, t, e) {
    Pt.S(l, t, e);
    var a = Ma;
    if (a && l) {
      var u = Pe(a).hoistableStyles, n = Da(l);
      t = t || "default";
      var i = u.get(n);
      if (!i) {
        var c = { loading: 0, preload: null };
        if (i = a.querySelector(
          zu(n)
        ))
          c.loading = 5;
        else {
          l = p(
            { rel: "stylesheet", href: l, "data-precedence": t },
            e
          ), (e = jt.get(n)) && df(l, e);
          var s = i = a.createElement("link");
          Hl(s), Xl(s, "link", l), s._p = new Promise(function(y, b) {
            s.onload = y, s.onerror = b;
          }), s.addEventListener("load", function() {
            c.loading |= 1;
          }), s.addEventListener("error", function() {
            c.loading |= 2;
          }), c.loading |= 4, Gn(i, t, a);
        }
        i = {
          type: "stylesheet",
          instance: i,
          count: 1,
          state: c
        }, u.set(n, i);
      }
    }
  }
  function Ph(l, t) {
    Pt.X(l, t);
    var e = Ma;
    if (e && l) {
      var a = Pe(e).hoistableScripts, u = Ua(l), n = a.get(u);
      n || (n = e.querySelector(Tu(u)), n || (l = p({ src: l, async: !0 }, t), (t = jt.get(u)) && rf(l, t), n = e.createElement("script"), Hl(n), Xl(n, "link", l), e.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, a.set(u, n));
    }
  }
  function lv(l, t) {
    Pt.M(l, t);
    var e = Ma;
    if (e && l) {
      var a = Pe(e).hoistableScripts, u = Ua(l), n = a.get(u);
      n || (n = e.querySelector(Tu(u)), n || (l = p({ src: l, async: !0, type: "module" }, t), (t = jt.get(u)) && rf(l, t), n = e.createElement("script"), Hl(n), Xl(n, "link", l), e.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, a.set(u, n));
    }
  }
  function rr(l, t, e, a) {
    var u = (u = k.current) ? Yn(u) : null;
    if (!u) throw Error(d(446));
    switch (l) {
      case "meta":
      case "title":
        return null;
      case "style":
        return typeof e.precedence == "string" && typeof e.href == "string" ? (t = Da(e.href), e = Pe(
          u
        ).hoistableStyles, a = e.get(t), a || (a = {
          type: "style",
          instance: null,
          count: 0,
          state: null
        }, e.set(t, a)), a) : { type: "void", instance: null, count: 0, state: null };
      case "link":
        if (e.rel === "stylesheet" && typeof e.href == "string" && typeof e.precedence == "string") {
          l = Da(e.href);
          var n = Pe(
            u
          ).hoistableStyles, i = n.get(l);
          if (i || (u = u.ownerDocument || u, i = {
            type: "stylesheet",
            instance: null,
            count: 0,
            state: { loading: 0, preload: null }
          }, n.set(l, i), (n = u.querySelector(
            zu(l)
          )) && !n._p && (i.instance = n, i.state.loading = 5), jt.has(l) || (e = {
            rel: "preload",
            as: "style",
            href: e.href,
            crossOrigin: e.crossOrigin,
            integrity: e.integrity,
            media: e.media,
            hrefLang: e.hrefLang,
            referrerPolicy: e.referrerPolicy
          }, jt.set(l, e), n || tv(
            u,
            l,
            e,
            i.state
          ))), t && a === null)
            throw Error(d(528, ""));
          return i;
        }
        if (t && a !== null)
          throw Error(d(529, ""));
        return null;
      case "script":
        return t = e.async, e = e.src, typeof e == "string" && t && typeof t != "function" && typeof t != "symbol" ? (t = Ua(e), e = Pe(
          u
        ).hoistableScripts, a = e.get(t), a || (a = {
          type: "script",
          instance: null,
          count: 0,
          state: null
        }, e.set(t, a)), a) : { type: "void", instance: null, count: 0, state: null };
      default:
        throw Error(d(444, l));
    }
  }
  function Da(l) {
    return 'href="' + yt(l) + '"';
  }
  function zu(l) {
    return 'link[rel="stylesheet"][' + l + "]";
  }
  function mr(l) {
    return p({}, l, {
      "data-precedence": l.precedence,
      precedence: null
    });
  }
  function tv(l, t, e, a) {
    l.querySelector('link[rel="preload"][as="style"][' + t + "]") ? a.loading = 1 : (t = l.createElement("link"), a.preload = t, t.addEventListener("load", function() {
      return a.loading |= 1;
    }), t.addEventListener("error", function() {
      return a.loading |= 2;
    }), Xl(t, "link", e), Hl(t), l.head.appendChild(t));
  }
  function Ua(l) {
    return '[src="' + yt(l) + '"]';
  }
  function Tu(l) {
    return "script[async]" + l;
  }
  function hr(l, t, e) {
    if (t.count++, t.instance === null)
      switch (t.type) {
        case "style":
          var a = l.querySelector(
            'style[data-href~="' + yt(e.href) + '"]'
          );
          if (a)
            return t.instance = a, Hl(a), a;
          var u = p({}, e, {
            "data-href": e.href,
            "data-precedence": e.precedence,
            href: null,
            precedence: null
          });
          return a = (l.ownerDocument || l).createElement(
            "style"
          ), Hl(a), Xl(a, "style", u), Gn(a, e.precedence, l), t.instance = a;
        case "stylesheet":
          u = Da(e.href);
          var n = l.querySelector(
            zu(u)
          );
          if (n)
            return t.state.loading |= 4, t.instance = n, Hl(n), n;
          a = mr(e), (u = jt.get(u)) && df(a, u), n = (l.ownerDocument || l).createElement("link"), Hl(n);
          var i = n;
          return i._p = new Promise(function(c, s) {
            i.onload = c, i.onerror = s;
          }), Xl(n, "link", a), t.state.loading |= 4, Gn(n, e.precedence, l), t.instance = n;
        case "script":
          return n = Ua(e.src), (u = l.querySelector(
            Tu(n)
          )) ? (t.instance = u, Hl(u), u) : (a = e, (u = jt.get(n)) && (a = p({}, e), rf(a, u)), l = l.ownerDocument || l, u = l.createElement("script"), Hl(u), Xl(u, "link", a), l.head.appendChild(u), t.instance = u);
        case "void":
          return null;
        default:
          throw Error(d(443, t.type));
      }
    else
      t.type === "stylesheet" && (t.state.loading & 4) === 0 && (a = t.instance, t.state.loading |= 4, Gn(a, e.precedence, l));
    return t.instance;
  }
  function Gn(l, t, e) {
    for (var a = e.querySelectorAll(
      'link[rel="stylesheet"][data-precedence],style[data-precedence]'
    ), u = a.length ? a[a.length - 1] : null, n = u, i = 0; i < a.length; i++) {
      var c = a[i];
      if (c.dataset.precedence === t) n = c;
      else if (n !== u) break;
    }
    n ? n.parentNode.insertBefore(l, n.nextSibling) : (t = e.nodeType === 9 ? e.head : e, t.insertBefore(l, t.firstChild));
  }
  function df(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.title == null && (l.title = t.title);
  }
  function rf(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.integrity == null && (l.integrity = t.integrity);
  }
  var Ln = null;
  function vr(l, t, e) {
    if (Ln === null) {
      var a = /* @__PURE__ */ new Map(), u = Ln = /* @__PURE__ */ new Map();
      u.set(e, a);
    } else
      u = Ln, a = u.get(e), a || (a = /* @__PURE__ */ new Map(), u.set(e, a));
    if (a.has(l)) return a;
    for (a.set(l, null), e = e.getElementsByTagName(l), u = 0; u < e.length; u++) {
      var n = e[u];
      if (!(n[Ga] || n[Bl] || l === "link" && n.getAttribute("rel") === "stylesheet") && n.namespaceURI !== "http://www.w3.org/2000/svg") {
        var i = n.getAttribute(t) || "";
        i = l + i;
        var c = a.get(i);
        c ? c.push(n) : a.set(i, [n]);
      }
    }
    return a;
  }
  function yr(l, t, e) {
    l = l.ownerDocument || l, l.head.insertBefore(
      e,
      t === "title" ? l.querySelector("head > title") : null
    );
  }
  function ev(l, t, e) {
    if (e === 1 || t.itemProp != null) return !1;
    switch (l) {
      case "meta":
      case "title":
        return !0;
      case "style":
        if (typeof t.precedence != "string" || typeof t.href != "string" || t.href === "")
          break;
        return !0;
      case "link":
        if (typeof t.rel != "string" || typeof t.href != "string" || t.href === "" || t.onLoad || t.onError)
          break;
        return t.rel === "stylesheet" ? (l = t.disabled, typeof t.precedence == "string" && l == null) : !0;
      case "script":
        if (t.async && typeof t.async != "function" && typeof t.async != "symbol" && !t.onLoad && !t.onError && t.src && typeof t.src == "string")
          return !0;
    }
    return !1;
  }
  function gr(l) {
    return !(l.type === "stylesheet" && (l.state.loading & 3) === 0);
  }
  function av(l, t, e, a) {
    if (e.type === "stylesheet" && (typeof a.media != "string" || matchMedia(a.media).matches !== !1) && (e.state.loading & 4) === 0) {
      if (e.instance === null) {
        var u = Da(a.href), n = t.querySelector(
          zu(u)
        );
        if (n) {
          t = n._p, t !== null && typeof t == "object" && typeof t.then == "function" && (l.count++, l = Xn.bind(l), t.then(l, l)), e.state.loading |= 4, e.instance = n, Hl(n);
          return;
        }
        n = t.ownerDocument || t, a = mr(a), (u = jt.get(u)) && df(a, u), n = n.createElement("link"), Hl(n);
        var i = n;
        i._p = new Promise(function(c, s) {
          i.onload = c, i.onerror = s;
        }), Xl(n, "link", a), e.instance = n;
      }
      l.stylesheets === null && (l.stylesheets = /* @__PURE__ */ new Map()), l.stylesheets.set(e, t), (t = e.state.preload) && (e.state.loading & 3) === 0 && (l.count++, e = Xn.bind(l), t.addEventListener("load", e), t.addEventListener("error", e));
    }
  }
  var mf = 0;
  function uv(l, t) {
    return l.stylesheets && l.count === 0 && Zn(l, l.stylesheets), 0 < l.count || 0 < l.imgCount ? function(e) {
      var a = setTimeout(function() {
        if (l.stylesheets && Zn(l, l.stylesheets), l.unsuspend) {
          var n = l.unsuspend;
          l.unsuspend = null, n();
        }
      }, 6e4 + t);
      0 < l.imgBytes && mf === 0 && (mf = 62500 * Yh());
      var u = setTimeout(
        function() {
          if (l.waitingForImages = !1, l.count === 0 && (l.stylesheets && Zn(l, l.stylesheets), l.unsuspend)) {
            var n = l.unsuspend;
            l.unsuspend = null, n();
          }
        },
        (l.imgBytes > mf ? 50 : 800) + t
      );
      return l.unsuspend = e, function() {
        l.unsuspend = null, clearTimeout(a), clearTimeout(u);
      };
    } : null;
  }
  function Xn() {
    if (this.count--, this.count === 0 && (this.imgCount === 0 || !this.waitingForImages)) {
      if (this.stylesheets) Zn(this, this.stylesheets);
      else if (this.unsuspend) {
        var l = this.unsuspend;
        this.unsuspend = null, l();
      }
    }
  }
  var Qn = null;
  function Zn(l, t) {
    l.stylesheets = null, l.unsuspend !== null && (l.count++, Qn = /* @__PURE__ */ new Map(), t.forEach(nv, l), Qn = null, Xn.call(l));
  }
  function nv(l, t) {
    if (!(t.state.loading & 4)) {
      var e = Qn.get(l);
      if (e) var a = e.get(null);
      else {
        e = /* @__PURE__ */ new Map(), Qn.set(l, e);
        for (var u = l.querySelectorAll(
          "link[data-precedence],style[data-precedence]"
        ), n = 0; n < u.length; n++) {
          var i = u[n];
          (i.nodeName === "LINK" || i.getAttribute("media") !== "not all") && (e.set(i.dataset.precedence, i), a = i);
        }
        a && e.set(null, a);
      }
      u = t.instance, i = u.getAttribute("data-precedence"), n = e.get(i) || a, n === a && e.set(null, u), e.set(i, u), this.count++, a = Xn.bind(this), u.addEventListener("load", a), u.addEventListener("error", a), n ? n.parentNode.insertBefore(u, n.nextSibling) : (l = l.nodeType === 9 ? l.head : l, l.insertBefore(u, l.firstChild)), t.state.loading |= 4;
    }
  }
  var ju = {
    $$typeof: Rl,
    Provider: null,
    Consumer: null,
    _currentValue: Z,
    _currentValue2: Z,
    _threadCount: 0
  };
  function iv(l, t, e, a, u, n, i, c, s) {
    this.tag = 1, this.containerInfo = l, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = ci(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = ci(0), this.hiddenUpdates = ci(null), this.identifierPrefix = a, this.onUncaughtError = u, this.onCaughtError = n, this.onRecoverableError = i, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = s, this.incompleteTransitions = /* @__PURE__ */ new Map();
  }
  function Sr(l, t, e, a, u, n, i, c, s, y, b, j) {
    return l = new iv(
      l,
      t,
      e,
      i,
      s,
      y,
      b,
      j,
      c
    ), t = 1, n === !0 && (t |= 24), n = ft(3, null, null, t), l.current = n, n.stateNode = l, t = Ki(), t.refCount++, l.pooledCache = t, t.refCount++, n.memoizedState = {
      element: a,
      isDehydrated: e,
      cache: t
    }, Wi(n), l;
  }
  function br(l) {
    return l ? (l = sa, l) : sa;
  }
  function pr(l, t, e, a, u, n) {
    u = br(u), a.context === null ? a.context = u : a.pendingContext = u, a = se(t), a.payload = { element: e }, n = n === void 0 ? null : n, n !== null && (a.callback = n), e = oe(l, a, t), e !== null && (tt(e, l, t), eu(e, l, t));
  }
  function Ar(l, t) {
    if (l = l.memoizedState, l !== null && l.dehydrated !== null) {
      var e = l.retryLane;
      l.retryLane = e !== 0 && e < t ? e : t;
    }
  }
  function hf(l, t) {
    Ar(l, t), (l = l.alternate) && Ar(l, t);
  }
  function zr(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = Ce(l, 67108864);
      t !== null && tt(t, l, 67108864), hf(l, 67108864);
    }
  }
  function Tr(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = mt();
      t = fi(t);
      var e = Ce(l, t);
      e !== null && tt(e, l, t), hf(l, t);
    }
  }
  var Vn = !0;
  function cv(l, t, e, a) {
    var u = A.T;
    A.T = null;
    var n = U.p;
    try {
      U.p = 2, vf(l, t, e, a);
    } finally {
      U.p = n, A.T = u;
    }
  }
  function fv(l, t, e, a) {
    var u = A.T;
    A.T = null;
    var n = U.p;
    try {
      U.p = 8, vf(l, t, e, a);
    } finally {
      U.p = n, A.T = u;
    }
  }
  function vf(l, t, e, a) {
    if (Vn) {
      var u = yf(a);
      if (u === null)
        lf(
          l,
          t,
          a,
          Kn,
          e
        ), Er(l, a);
      else if (ov(
        u,
        l,
        t,
        e,
        a
      ))
        a.stopPropagation();
      else if (Er(l, a), t & 4 && -1 < sv.indexOf(l)) {
        for (; u !== null; ) {
          var n = Ie(u);
          if (n !== null)
            switch (n.tag) {
              case 3:
                if (n = n.stateNode, n.current.memoizedState.isDehydrated) {
                  var i = _e(n.pendingLanes);
                  if (i !== 0) {
                    var c = n;
                    for (c.pendingLanes |= 2, c.entangledLanes |= 2; i; ) {
                      var s = 1 << 31 - it(i);
                      c.entanglements[1] |= s, i &= ~s;
                    }
                    Ct(n), (nl & 6) === 0 && (Nn = ut() + 500, Su(0));
                  }
                }
                break;
              case 31:
              case 13:
                c = Ce(n, 2), c !== null && tt(c, n, 2), _n(), hf(n, 2);
            }
          if (n = yf(a), n === null && lf(
            l,
            t,
            a,
            Kn,
            e
          ), n === u) break;
          u = n;
        }
        u !== null && a.stopPropagation();
      } else
        lf(
          l,
          t,
          a,
          null,
          e
        );
    }
  }
  function yf(l) {
    return l = gi(l), gf(l);
  }
  var Kn = null;
  function gf(l) {
    if (Kn = null, l = Fe(l), l !== null) {
      var t = M(l);
      if (t === null) l = null;
      else {
        var e = t.tag;
        if (e === 13) {
          if (l = X(t), l !== null) return l;
          l = null;
        } else if (e === 31) {
          if (l = V(t), l !== null) return l;
          l = null;
        } else if (e === 3) {
          if (t.stateNode.current.memoizedState.isDehydrated)
            return t.tag === 3 ? t.stateNode.containerInfo : null;
          l = null;
        } else t !== l && (l = null);
      }
    }
    return Kn = l, null;
  }
  function jr(l) {
    switch (l) {
      case "beforetoggle":
      case "cancel":
      case "click":
      case "close":
      case "contextmenu":
      case "copy":
      case "cut":
      case "auxclick":
      case "dblclick":
      case "dragend":
      case "dragstart":
      case "drop":
      case "focusin":
      case "focusout":
      case "input":
      case "invalid":
      case "keydown":
      case "keypress":
      case "keyup":
      case "mousedown":
      case "mouseup":
      case "paste":
      case "pause":
      case "play":
      case "pointercancel":
      case "pointerdown":
      case "pointerup":
      case "ratechange":
      case "reset":
      case "resize":
      case "seeked":
      case "submit":
      case "toggle":
      case "touchcancel":
      case "touchend":
      case "touchstart":
      case "volumechange":
      case "change":
      case "selectionchange":
      case "textInput":
      case "compositionstart":
      case "compositionend":
      case "compositionupdate":
      case "beforeblur":
      case "afterblur":
      case "beforeinput":
      case "blur":
      case "fullscreenchange":
      case "focus":
      case "hashchange":
      case "popstate":
      case "select":
      case "selectstart":
        return 2;
      case "drag":
      case "dragenter":
      case "dragexit":
      case "dragleave":
      case "dragover":
      case "mousemove":
      case "mouseout":
      case "mouseover":
      case "pointermove":
      case "pointerout":
      case "pointerover":
      case "scroll":
      case "touchmove":
      case "wheel":
      case "mouseenter":
      case "mouseleave":
      case "pointerenter":
      case "pointerleave":
        return 8;
      case "message":
        switch ($r()) {
          case Df:
            return 2;
          case Uf:
            return 8;
          case Ru:
          case Wr:
            return 32;
          case Rf:
            return 268435456;
          default:
            return 32;
        }
      default:
        return 32;
    }
  }
  var Sf = !1, Ae = null, ze = null, Te = null, Eu = /* @__PURE__ */ new Map(), xu = /* @__PURE__ */ new Map(), je = [], sv = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
    " "
  );
  function Er(l, t) {
    switch (l) {
      case "focusin":
      case "focusout":
        Ae = null;
        break;
      case "dragenter":
      case "dragleave":
        ze = null;
        break;
      case "mouseover":
      case "mouseout":
        Te = null;
        break;
      case "pointerover":
      case "pointerout":
        Eu.delete(t.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        xu.delete(t.pointerId);
    }
  }
  function Nu(l, t, e, a, u, n) {
    return l === null || l.nativeEvent !== n ? (l = {
      blockedOn: t,
      domEventName: e,
      eventSystemFlags: a,
      nativeEvent: n,
      targetContainers: [u]
    }, t !== null && (t = Ie(t), t !== null && zr(t)), l) : (l.eventSystemFlags |= a, t = l.targetContainers, u !== null && t.indexOf(u) === -1 && t.push(u), l);
  }
  function ov(l, t, e, a, u) {
    switch (t) {
      case "focusin":
        return Ae = Nu(
          Ae,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "dragenter":
        return ze = Nu(
          ze,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "mouseover":
        return Te = Nu(
          Te,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "pointerover":
        var n = u.pointerId;
        return Eu.set(
          n,
          Nu(
            Eu.get(n) || null,
            l,
            t,
            e,
            a,
            u
          )
        ), !0;
      case "gotpointercapture":
        return n = u.pointerId, xu.set(
          n,
          Nu(
            xu.get(n) || null,
            l,
            t,
            e,
            a,
            u
          )
        ), !0;
    }
    return !1;
  }
  function xr(l) {
    var t = Fe(l.target);
    if (t !== null) {
      var e = M(t);
      if (e !== null) {
        if (t = e.tag, t === 13) {
          if (t = X(e), t !== null) {
            l.blockedOn = t, Gf(l.priority, function() {
              Tr(e);
            });
            return;
          }
        } else if (t === 31) {
          if (t = V(e), t !== null) {
            l.blockedOn = t, Gf(l.priority, function() {
              Tr(e);
            });
            return;
          }
        } else if (t === 3 && e.stateNode.current.memoizedState.isDehydrated) {
          l.blockedOn = e.tag === 3 ? e.stateNode.containerInfo : null;
          return;
        }
      }
    }
    l.blockedOn = null;
  }
  function Jn(l) {
    if (l.blockedOn !== null) return !1;
    for (var t = l.targetContainers; 0 < t.length; ) {
      var e = yf(l.nativeEvent);
      if (e === null) {
        e = l.nativeEvent;
        var a = new e.constructor(
          e.type,
          e
        );
        yi = a, e.target.dispatchEvent(a), yi = null;
      } else
        return t = Ie(e), t !== null && zr(t), l.blockedOn = e, !1;
      t.shift();
    }
    return !0;
  }
  function Nr(l, t, e) {
    Jn(l) && e.delete(t);
  }
  function dv() {
    Sf = !1, Ae !== null && Jn(Ae) && (Ae = null), ze !== null && Jn(ze) && (ze = null), Te !== null && Jn(Te) && (Te = null), Eu.forEach(Nr), xu.forEach(Nr);
  }
  function wn(l, t) {
    l.blockedOn === t && (l.blockedOn = null, Sf || (Sf = !0, m.unstable_scheduleCallback(
      m.unstable_NormalPriority,
      dv
    )));
  }
  var $n = null;
  function Or(l) {
    $n !== l && ($n = l, m.unstable_scheduleCallback(
      m.unstable_NormalPriority,
      function() {
        $n === l && ($n = null);
        for (var t = 0; t < l.length; t += 3) {
          var e = l[t], a = l[t + 1], u = l[t + 2];
          if (typeof a != "function") {
            if (gf(a || e) === null)
              continue;
            break;
          }
          var n = Ie(e);
          n !== null && (l.splice(t, 3), t -= 3, vc(
            n,
            {
              pending: !0,
              data: u,
              method: e.method,
              action: a
            },
            a,
            u
          ));
        }
      }
    ));
  }
  function Ra(l) {
    function t(s) {
      return wn(s, l);
    }
    Ae !== null && wn(Ae, l), ze !== null && wn(ze, l), Te !== null && wn(Te, l), Eu.forEach(t), xu.forEach(t);
    for (var e = 0; e < je.length; e++) {
      var a = je[e];
      a.blockedOn === l && (a.blockedOn = null);
    }
    for (; 0 < je.length && (e = je[0], e.blockedOn === null); )
      xr(e), e.blockedOn === null && je.shift();
    if (e = (l.ownerDocument || l).$$reactFormReplay, e != null)
      for (a = 0; a < e.length; a += 3) {
        var u = e[a], n = e[a + 1], i = u[Wl] || null;
        if (typeof n == "function")
          i || Or(e);
        else if (i) {
          var c = null;
          if (n && n.hasAttribute("formAction")) {
            if (u = n, i = n[Wl] || null)
              c = i.formAction;
            else if (gf(u) !== null) continue;
          } else c = i.action;
          typeof c == "function" ? e[a + 1] = c : (e.splice(a, 3), a -= 3), Or(e);
        }
      }
  }
  function _r() {
    function l(n) {
      n.canIntercept && n.info === "react-transition" && n.intercept({
        handler: function() {
          return new Promise(function(i) {
            return u = i;
          });
        },
        focusReset: "manual",
        scroll: "manual"
      });
    }
    function t() {
      u !== null && (u(), u = null), a || setTimeout(e, 20);
    }
    function e() {
      if (!a && !navigation.transition) {
        var n = navigation.currentEntry;
        n && n.url != null && navigation.navigate(n.url, {
          state: n.getState(),
          info: "react-transition",
          history: "replace"
        });
      }
    }
    if (typeof navigation == "object") {
      var a = !1, u = null;
      return navigation.addEventListener("navigate", l), navigation.addEventListener("navigatesuccess", t), navigation.addEventListener("navigateerror", t), setTimeout(e, 100), function() {
        a = !0, navigation.removeEventListener("navigate", l), navigation.removeEventListener("navigatesuccess", t), navigation.removeEventListener("navigateerror", t), u !== null && (u(), u = null);
      };
    }
  }
  function bf(l) {
    this._internalRoot = l;
  }
  Wn.prototype.render = bf.prototype.render = function(l) {
    var t = this._internalRoot;
    if (t === null) throw Error(d(409));
    var e = t.current, a = mt();
    pr(e, a, l, t, null, null);
  }, Wn.prototype.unmount = bf.prototype.unmount = function() {
    var l = this._internalRoot;
    if (l !== null) {
      this._internalRoot = null;
      var t = l.containerInfo;
      pr(l.current, 2, null, l, null, null), _n(), t[ke] = null;
    }
  };
  function Wn(l) {
    this._internalRoot = l;
  }
  Wn.prototype.unstable_scheduleHydration = function(l) {
    if (l) {
      var t = Yf();
      l = { blockedOn: null, target: l, priority: t };
      for (var e = 0; e < je.length && t !== 0 && t < je[e].priority; e++) ;
      je.splice(e, 0, l), e === 0 && xr(l);
    }
  };
  var Mr = x.version;
  if (Mr !== "19.2.8")
    throw Error(
      d(
        527,
        Mr,
        "19.2.8"
      )
    );
  U.findDOMNode = function(l) {
    var t = l._reactInternals;
    if (t === void 0)
      throw typeof l.render == "function" ? Error(d(188)) : (l = Object.keys(l).join(","), Error(d(268, l)));
    return l = z(t), l = l !== null ? D(l) : null, l = l === null ? null : l.stateNode, l;
  };
  var rv = {
    bundleType: 0,
    version: "19.2.8",
    rendererPackageName: "react-dom",
    currentDispatcherRef: A,
    reconcilerVersion: "19.2.8"
  };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var kn = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!kn.isDisabled && kn.supportsFiber)
      try {
        qa = kn.inject(
          rv
        ), nt = kn;
      } catch {
      }
  }
  return _u.createRoot = function(l, t) {
    if (!C(l)) throw Error(d(299));
    var e = !1, a = "", u = Bo, n = Yo, i = Go;
    return t != null && (t.unstable_strictMode === !0 && (e = !0), t.identifierPrefix !== void 0 && (a = t.identifierPrefix), t.onUncaughtError !== void 0 && (u = t.onUncaughtError), t.onCaughtError !== void 0 && (n = t.onCaughtError), t.onRecoverableError !== void 0 && (i = t.onRecoverableError)), t = Sr(
      l,
      1,
      !1,
      null,
      null,
      e,
      a,
      null,
      u,
      n,
      i,
      _r
    ), l[ke] = t.current, Pc(l), new bf(t);
  }, _u.hydrateRoot = function(l, t, e) {
    if (!C(l)) throw Error(d(299));
    var a = !1, u = "", n = Bo, i = Yo, c = Go, s = null;
    return e != null && (e.unstable_strictMode === !0 && (a = !0), e.identifierPrefix !== void 0 && (u = e.identifierPrefix), e.onUncaughtError !== void 0 && (n = e.onUncaughtError), e.onCaughtError !== void 0 && (i = e.onCaughtError), e.onRecoverableError !== void 0 && (c = e.onRecoverableError), e.formState !== void 0 && (s = e.formState)), t = Sr(
      l,
      1,
      !0,
      t,
      e ?? null,
      a,
      u,
      s,
      n,
      i,
      c,
      _r
    ), t.context = br(null), e = t.current, a = mt(), a = fi(a), u = se(a), u.callback = null, oe(e, u, a), e = a, t.current.lanes = e, Ya(t, e), Ct(t), l[ke] = t.current, Pc(l), new Wn(t);
  }, _u.version = "19.2.8", _u;
}
var Lr;
function zv() {
  if (Lr) return zf.exports;
  Lr = 1;
  function m() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(m);
      } catch (x) {
        console.error(x);
      }
  }
  return m(), zf.exports = Av(), zf.exports;
}
var Tv = zv();
class jv extends Error {
  constructor(x, _, d) {
    super(x), this.status = _, this.payload = d;
  }
  status;
  payload;
}
async function et(m, x = {}) {
  const _ = new Headers(x.headers);
  x.body && !_.has("content-type") && _.set("content-type", "application/json");
  const d = await fetch(m, { ...x, headers: _, credentials: "same-origin" });
  let C = {};
  try {
    C = await d.json();
  } catch {
  }
  if (!d.ok) {
    const M = C && typeof C == "object" ? C : {}, X = typeof M.error == "string" ? M.error : typeof M.message == "string" ? M.message : `Request failed (${d.status})`;
    throw new jv(X, d.status, C);
  }
  return C;
}
const at = {
  commandCenter: () => et("/api/console/command-center"),
  work: () => et("/api/console/requirements"),
  workPortfolio: () => et("/api/console/work-portfolio"),
  automations: () => et("/api/console/automations"),
  automationSettings: () => et("/api/console/automation-settings"),
  connector: () => et("/api/console/connector/status"),
  advanced: () => et("/api/console/advanced"),
  automationAction: (m, x, _, d) => et(`/api/console/automations/${encodeURIComponent(m)}/${encodeURIComponent(x)}/${encodeURIComponent(_)}/${encodeURIComponent(d)}`, { method: "POST", body: "{}" }),
  providerAction: (m, x) => et(`/api/console/providers/${encodeURIComponent(m)}/${x}`, { method: "POST", body: "{}" }),
  providerHealth: (m) => et("/api/console/providers/health", { method: "POST", body: JSON.stringify({ providerId: m }) }),
  localToolAction: (m, x) => et(`/api/console/local-tools/${encodeURIComponent(m)}/${x}`, { method: "POST", body: "{}" }),
  localToolHealth: (m) => et("/api/console/local-tools/health", { method: "POST", body: JSON.stringify({ toolId: m }) }),
  registerRepository: (m, x) => et("/api/repositories/register", { method: "POST", body: JSON.stringify({ path: m, displayName: x }) }),
  removeRepository: (m) => et(`/api/repositories/${encodeURIComponent(m)}/remove`, { method: "POST", body: "{}" })
}, Zr = [
  { id: "overview", label: "Overview", group: "daily" },
  { id: "automations", label: "Automations", group: "daily" },
  { id: "work", label: "Work", group: "daily" },
  { id: "capabilities", label: "Capabilities", group: "manage" },
  { id: "repositories", label: "Repositories", group: "manage" },
  { id: "settings", label: "Settings", group: "manage" },
  { id: "system", label: "System", group: "system" }
];
function Xr() {
  const m = location.hash.replace(/^#\/?/, "").split("/")[0];
  return Zr.some((x) => x.id === m) ? m : "overview";
}
function le({ children: m, ...x }) {
  return /* @__PURE__ */ f.jsx("svg", { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: "1.55", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", ...x, children: m });
}
const Ev = (m) => /* @__PURE__ */ f.jsx(le, { ...m, children: /* @__PURE__ */ f.jsx("path", { d: "M3 9.2 10 3l7 6.2v7.1a.7.7 0 0 1-.7.7h-4.2v-5H7.9v5H3.7a.7.7 0 0 1-.7-.7z" }) }), xv = (m) => /* @__PURE__ */ f.jsxs(le, { ...m, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4.2 6.3A6.5 6.5 0 0 1 16 7" }),
  /* @__PURE__ */ f.jsx("path", { d: "m16 3 .4 4.4-4.4.4" }),
  /* @__PURE__ */ f.jsx("path", { d: "M15.8 13.7A6.5 6.5 0 0 1 4 13" }),
  /* @__PURE__ */ f.jsx("path", { d: "m4 17-.4-4.4 4.4-.4" })
] }), Nv = (m) => /* @__PURE__ */ f.jsxs(le, { ...m, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4 5.2h12v10.6H4z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M7 5.2V3.6h6v1.6M7 9h6M7 12h4" })
] }), Ov = (m) => /* @__PURE__ */ f.jsx(le, { ...m, children: /* @__PURE__ */ f.jsx("path", { d: "m10 2.8 2 4 4.4.7-3.2 3.1.8 4.4-4-2.1L6 15l.8-4.4-3.2-3.1L8 6.8z" }) }), _v = (m) => /* @__PURE__ */ f.jsxs(le, { ...m, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4 3.5h5l1.4 2H16v11H4z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M4 8h12" })
] }), Mv = (m) => /* @__PURE__ */ f.jsxs(le, { ...m, children: [
  /* @__PURE__ */ f.jsx("circle", { cx: "10", cy: "10", r: "2.5" }),
  /* @__PURE__ */ f.jsx("path", { d: "M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" })
] }), Dv = (m) => /* @__PURE__ */ f.jsxs(le, { ...m, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M3.2 4.5h13.6v9.2H3.2z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M7 17h6M10 13.7V17" })
] }), Uv = (m) => /* @__PURE__ */ f.jsxs(le, { ...m, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M15.5 6A6 6 0 1 0 16 12" }),
  /* @__PURE__ */ f.jsx("path", { d: "m15.5 2.8.3 3.7-3.7.2" })
] }), Rv = (m) => /* @__PURE__ */ f.jsxs(le, { ...m, children: [
  /* @__PURE__ */ f.jsx("circle", { cx: "8.8", cy: "8.8", r: "5" }),
  /* @__PURE__ */ f.jsx("path", { d: "m12.5 12.5 4 4" })
] }), Cv = { overview: Ev, automations: xv, work: Nv, capabilities: Ov, repositories: _v, settings: Mv, system: Dv }, Hv = { daily: "Workspace", manage: "Configure", system: "System" };
function qv({ route: m }) {
  let x = "";
  return /* @__PURE__ */ f.jsxs("aside", { className: "sidebar", children: [
    /* @__PURE__ */ f.jsxs("div", { className: "brand", children: [
      /* @__PURE__ */ f.jsx("span", { className: "brand-mark", children: "F" }),
      /* @__PURE__ */ f.jsxs("div", { children: [
        /* @__PURE__ */ f.jsx("strong", { children: "Forge" }),
        /* @__PURE__ */ f.jsx("small", { children: "Utility Console" })
      ] })
    ] }),
    /* @__PURE__ */ f.jsx("nav", { children: Zr.map((_) => {
      const d = Cv[_.id], C = _.group !== x;
      return x = _.group, /* @__PURE__ */ f.jsxs("div", { className: C ? "nav-group-start" : "nav-item", children: [
        C && /* @__PURE__ */ f.jsx("div", { className: "nav-group-label", children: Hv[_.group] }),
        /* @__PURE__ */ f.jsxs("a", { href: `#/${_.id}`, className: m === _.id ? "active" : "", children: [
          /* @__PURE__ */ f.jsx(d, {}),
          /* @__PURE__ */ f.jsx("span", { children: _.label })
        ] })
      ] }, _.id);
    }) }),
    /* @__PURE__ */ f.jsxs("div", { className: "sidebar-foot", children: [
      /* @__PURE__ */ f.jsx("span", { className: "pulse-dot" }),
      /* @__PURE__ */ f.jsxs("span", { children: [
        /* @__PURE__ */ f.jsx("strong", { children: "Runtime connected" }),
        /* @__PURE__ */ f.jsx("small", { children: "ChatGPT remains the primary workspace" })
      ] })
    ] })
  ] });
}
function Bv({ route: m, children: x }) {
  return /* @__PURE__ */ f.jsxs("div", { className: "app-shell", children: [
    /* @__PURE__ */ f.jsx(qv, { route: m }),
    /* @__PURE__ */ f.jsx("main", { className: "workspace", children: x })
  ] });
}
function we(m) {
  if (!m) return "—";
  const x = new Date(m);
  return Number.isNaN(x.getTime()) ? m : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: !1 }).format(x);
}
function _t(m, x = 86) {
  const _ = (m ?? "").trim();
  return _.length > x ? `${_.slice(0, x - 1)}…` : _;
}
function Ca(m, x = "—") {
  return typeof m == "string" && m.trim() ? m : String(m ?? x);
}
function Pn(m) {
  return JSON.stringify(m ?? {}, null, 2);
}
function $e({ eyebrow: m, title: x, description: _, refreshedAt: d, busy: C, onRefresh: M, actions: X }) {
  return /* @__PURE__ */ f.jsxs("header", { className: "command-bar", children: [
    /* @__PURE__ */ f.jsxs("div", { className: "command-title", children: [
      m && /* @__PURE__ */ f.jsx("div", { className: "eyebrow", children: m }),
      /* @__PURE__ */ f.jsx("h1", { children: x }),
      /* @__PURE__ */ f.jsx("p", { children: _ })
    ] }),
    /* @__PURE__ */ f.jsxs("div", { className: "command-actions", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "command-meta", children: [
        /* @__PURE__ */ f.jsx("span", { children: "Last synced" }),
        /* @__PURE__ */ f.jsx("strong", { children: we(d) })
      ] }),
      /* @__PURE__ */ f.jsx("button", { className: "icon-button", onClick: M, disabled: C, title: "Refresh", children: /* @__PURE__ */ f.jsx(Uv, {}) }),
      X,
      /* @__PURE__ */ f.jsx("a", { className: "button ghost-link", href: "https://chatgpt.com", target: "_blank", rel: "noreferrer", children: "Open ChatGPT ↗" })
    ] })
  ] });
}
function Yv(m) {
  const x = (m ?? "").toLowerCase();
  return /ready|enabled|healthy|success|done|completed|active/.test(x) ? "success" : /attention|blocked|error|fail|danger/.test(x) ? "danger" : /pause|waiting|warn|degrad|stale|planned/.test(x) ? "warning" : /info|running/.test(x) ? "info" : "neutral";
}
function Kl({ label: m, tone: x }) {
  const _ = x && ["success", "warning", "danger", "info", "neutral"].includes(x) ? x : Yv(x ?? m);
  return /* @__PURE__ */ f.jsxs("span", { className: "status-text", children: [
    /* @__PURE__ */ f.jsx("i", { className: `status-dot ${_}` }),
    m
  ] });
}
function In({ title: m, meta: x, actions: _ }) {
  return /* @__PURE__ */ f.jsxs("div", { className: "section-header", children: [
    /* @__PURE__ */ f.jsxs("div", { children: [
      /* @__PURE__ */ f.jsx("h2", { children: m }),
      x && /* @__PURE__ */ f.jsx("span", { children: x })
    ] }),
    _ && /* @__PURE__ */ f.jsx("div", { children: _ })
  ] });
}
function Gv(m) {
  return m.advanced?.status ?? "";
}
function Lv(m) {
  return ["blocked", "failed"].includes(Gv(m));
}
function xf(m) {
  return `${String(m.title ?? "")}:${String(m.reason ?? "")}`;
}
function Xv(m) {
  const x = `${m.readinessLabel ?? ""} ${m.statusLabel ?? ""}`;
  return /error|failed|blocked|unavailable|degraded|warning|attention/i.test(x);
}
function Qv({ data: m, busy: x, onRefresh: _ }) {
  const d = m.commandCenter, C = m.workPortfolio, M = m.automations.summary, X = d.pluginSummary ?? {}, V = d.repositories ?? [], O = d.readiness ?? {}, z = X.total ?? (d.plugins ?? []).length, D = V.filter(Xv).length, p = String(O.state ?? O.status ?? "ready"), N = /error|failed|blocked|unavailable|degraded|warning|attention/i.test(p), Y = String(O.label ?? O.headline ?? (N ? "Needs attention" : "Ready")), El = C.items.filter(Lv).slice(0, 4), xl = [...d.handoffs ?? []].filter((Q, $, Cl) => Cl.findIndex((wl) => xf(wl) === xf(Q)) === $), Nl = [
    ...N ? [{
      key: "runtime",
      source: "System",
      title: Y,
      summary: _t(String(O.explanation ?? O.summary ?? "Inspect Runtime status."), 112),
      statusLabel: "Inspect",
      tone: p,
      href: "#/system"
    }] : [],
    ...El.map((Q) => ({
      key: `work:${Q.id}`,
      source: `Work · ${Q.repositoryName}`,
      title: Q.title,
      summary: _t(Q.latestSummary || Q.nextAction || Q.objective, 112),
      statusLabel: Q.statusLabel,
      tone: Q.tone ?? "warning",
      href: "#/work"
    })),
    ...xl.slice(0, 2).map((Q, $) => ({
      key: `handoff:${$}:${xf(Q)}`,
      source: "Decision",
      title: String(Q.title ?? "Needs review"),
      summary: _t(String(Q.reason ?? Q.summary ?? "Review in ChatGPT."), 112),
      statusLabel: String(Q.statusLabel ?? "Review"),
      tone: String(Q.tone ?? "warning"),
      href: "#/work"
    })),
    ...(M.needsAttention ?? 0) > 0 ? [{
      key: "automations",
      source: "Automations",
      title: `${M.needsAttention} automation${M.needsAttention === 1 ? "" : "s"} need attention`,
      summary: "Inspect configured routines and schedules.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/automations"
    }] : [],
    ...(X.needsAttention ?? 0) > 0 ? [{
      key: "capabilities",
      source: "Capabilities",
      title: `${X.needsAttention} ${X.needsAttention === 1 ? "capability" : "capabilities"} need attention`,
      summary: "Inspect configured capability readiness.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/capabilities"
    }] : [],
    ...D > 0 ? [{
      key: "repositories",
      source: "Repositories",
      title: `${D} ${D === 1 ? "repository" : "repositories"} need attention`,
      summary: "Inspect repository registration and readiness.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/repositories"
    }] : []
  ].filter((Q, $, Cl) => Cl.findIndex((wl) => wl.key === Q.key) === $).slice(0, 6), cl = C.summary.needsAttention ? `${C.summary.open} open · ${C.summary.needsAttention} need attention` : `${C.summary.open} open · no attention needed`, tl = M.needsAttention ? `${M.enabled} enabled · ${M.needsAttention} need attention` : M.paused ? `${M.enabled} enabled · ${M.paused} paused` : `${M.enabled} enabled · healthy`, Rl = (X.needsAttention ?? 0) > 0 ? `${X.ready ?? 0} / ${z} ready · ${X.needsAttention} need attention` : `${X.ready ?? 0} / ${z} ready`, Jl = D ? `${V.length} registered · ${D} need attention` : `${V.length} registered`, ht = [
    { key: "work", label: "Work", summary: cl, href: "#/work", statusLabel: C.summary.needsAttention ? "Attention" : void 0, tone: C.summary.needsAttention ? "warning" : void 0 },
    { key: "automations", label: "Automations", summary: tl, href: "#/automations", statusLabel: M.needsAttention ? "Attention" : void 0, tone: M.needsAttention ? "warning" : void 0 },
    { key: "capabilities", label: "Capabilities", summary: Rl, href: "#/capabilities", statusLabel: (X.needsAttention ?? 0) > 0 ? "Attention" : void 0, tone: (X.needsAttention ?? 0) > 0 ? "warning" : void 0 },
    { key: "repositories", label: "Repositories", summary: Jl, href: "#/repositories", statusLabel: D ? "Attention" : void 0, tone: D ? "warning" : void 0 },
    { key: "system", label: "System", summary: N ? Y : "Runtime ready", href: "#/system", statusLabel: N ? "Attention" : "Ready", tone: N ? p : "success" }
  ];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx(
      $e,
      {
        eyebrow: "FORGE CONTROL PLANE",
        title: "Overview",
        description: "需要处理的事项，以及 Forge 各工作区当前状态。",
        refreshedAt: m.generatedAt,
        busy: x,
        onRefresh: _
      }
    ),
    /* @__PURE__ */ f.jsxs("div", { className: "overview-home", children: [
      /* @__PURE__ */ f.jsxs("section", { className: "page-section overview-attention-section", children: [
        /* @__PURE__ */ f.jsx(In, { title: "Needs attention", meta: Nl.length ? `${Nl.length} items` : "All clear" }),
        Nl.length ? /* @__PURE__ */ f.jsx("div", { className: "overview-attention-list", children: Nl.map((Q) => /* @__PURE__ */ f.jsxs("a", { className: "overview-attention-row", href: Q.href, children: [
          /* @__PURE__ */ f.jsx("div", { className: "overview-attention-source", children: Q.source }),
          /* @__PURE__ */ f.jsxs("div", { className: "overview-attention-copy", children: [
            /* @__PURE__ */ f.jsx("strong", { children: _t(Q.title, 82) }),
            /* @__PURE__ */ f.jsx("p", { children: Q.summary })
          ] }),
          /* @__PURE__ */ f.jsx(Kl, { label: Q.statusLabel, tone: Q.tone }),
          /* @__PURE__ */ f.jsx("span", { className: "overview-row-arrow", "aria-hidden": "true", children: "→" })
        ] }, Q.key)) }) : /* @__PURE__ */ f.jsxs("div", { className: "overview-clear-state", children: [
          /* @__PURE__ */ f.jsx(Kl, { label: "No action needed", tone: "success" }),
          /* @__PURE__ */ f.jsx("span", { children: "Forge is operating normally." })
        ] })
      ] }),
      /* @__PURE__ */ f.jsxs("section", { className: "page-section overview-workspace-section", children: [
        /* @__PURE__ */ f.jsx(In, { title: "Workspace", meta: "Current state" }),
        /* @__PURE__ */ f.jsx("div", { className: "overview-workspace-list", children: ht.map((Q) => /* @__PURE__ */ f.jsxs("a", { className: "overview-workspace-row", href: Q.href, children: [
          /* @__PURE__ */ f.jsx("strong", { children: Q.label }),
          /* @__PURE__ */ f.jsx("span", { children: Q.summary }),
          Q.statusLabel && /* @__PURE__ */ f.jsx(Kl, { label: Q.statusLabel, tone: Q.tone }),
          /* @__PURE__ */ f.jsx("span", { className: "overview-row-arrow", "aria-hidden": "true", children: "→" })
        ] }, Q.key)) })
      ] })
    ] })
  ] });
}
function Of({ items: m, value: x, onChange: _ }) {
  return /* @__PURE__ */ f.jsx("div", { className: "segmented", role: "tablist", children: m.map((d) => /* @__PURE__ */ f.jsxs("button", { role: "tab", "aria-selected": x === d.id, className: x === d.id ? "selected" : "", onClick: () => _(d.id), children: [
    d.label,
    d.count !== void 0 && /* @__PURE__ */ f.jsx("span", { children: d.count })
  ] }, d.id)) });
}
function li({ title: m, subtitle: x, actions: _, children: d, empty: C }) {
  return /* @__PURE__ */ f.jsx("aside", { className: "detail-pane", children: m ? /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsxs("div", { className: "detail-head", children: [
      /* @__PURE__ */ f.jsxs("div", { children: [
        /* @__PURE__ */ f.jsx("div", { className: "eyebrow", children: "DETAIL" }),
        /* @__PURE__ */ f.jsx("h2", { children: m }),
        x && /* @__PURE__ */ f.jsx("p", { children: x })
      ] }),
      _ && /* @__PURE__ */ f.jsx("div", { className: "detail-actions", children: _ })
    ] }),
    /* @__PURE__ */ f.jsx("div", { className: "detail-body", children: d })
  ] }) : /* @__PURE__ */ f.jsx("div", { className: "detail-empty", children: C ?? "选择一项查看详细配置" }) });
}
function Du({ items: m }) {
  return /* @__PURE__ */ f.jsx("dl", { className: "definition-list", children: m.map(([x, _]) => /* @__PURE__ */ f.jsxs("div", { children: [
    /* @__PURE__ */ f.jsx("dt", { children: x }),
    /* @__PURE__ */ f.jsx("dd", { children: _ })
  ] }, x)) });
}
function xe({ children: m, className: x = "", ..._ }) {
  return /* @__PURE__ */ f.jsx("button", { className: `button ${x}`.trim(), ..._, children: m });
}
function Zv({ data: m, busy: x, onRefresh: _, onAction: d }) {
  const C = m.automations.automations, [M, X] = Sl.useState("enabled"), V = Sl.useMemo(() => C.filter((N) => M === "all" || N.status === M), [C, M]), [O, z] = Sl.useState(), D = (N) => `${N.source}:${N.repoId}:${N.id}`, p = V.find((N) => D(N) === O) ?? V[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($e, { eyebrow: "LONG-RUNNING CONFIG", title: "Automations", description: "管理 Forge 持久化 Schedule 与 Assistant Routine；结果正文继续发送到 ChatGPT / Email。", refreshedAt: m.automations.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ f.jsx("div", { className: "toolbar", children: /* @__PURE__ */ f.jsx(Of, { value: M, onChange: X, items: [{ id: "enabled", label: "Enabled", count: C.filter((N) => N.status === "enabled").length }, { id: "paused", label: "Paused", count: C.filter((N) => N.status === "paused").length }, { id: "attention", label: "Attention", count: C.filter((N) => N.status === "attention").length }, { id: "all", label: "All", count: C.length }] }) }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace automation-layout", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "table-wrap", children: [
        /* @__PURE__ */ f.jsxs("table", { className: "data-table", children: [
          /* @__PURE__ */ f.jsx("thead", { children: /* @__PURE__ */ f.jsxs("tr", { children: [
            /* @__PURE__ */ f.jsx("th", { children: "Automation" }),
            /* @__PURE__ */ f.jsx("th", { children: "Schedule" }),
            /* @__PURE__ */ f.jsx("th", { children: "Delivery" }),
            /* @__PURE__ */ f.jsx("th", { children: "Status" }),
            /* @__PURE__ */ f.jsx("th", { children: "Last" }),
            /* @__PURE__ */ f.jsx("th", { children: "Next" })
          ] }) }),
          /* @__PURE__ */ f.jsx("tbody", { children: V.map((N) => /* @__PURE__ */ f.jsxs("tr", { className: p && D(p) === D(N) ? "selected" : "", onClick: () => z(D(N)), children: [
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx("strong", { children: N.name }),
              /* @__PURE__ */ f.jsxs("small", { children: [
                N.repositoryName,
                " · ",
                N.source
              ] })
            ] }),
            /* @__PURE__ */ f.jsx("td", { children: N.schedule }),
            /* @__PURE__ */ f.jsx("td", { children: N.delivery ?? "—" }),
            /* @__PURE__ */ f.jsx("td", { children: /* @__PURE__ */ f.jsx(Kl, { label: N.status, tone: N.status }) }),
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx("span", { children: _t(N.lastResult, 30) || "—" }),
              /* @__PURE__ */ f.jsx("small", { children: we(N.lastRunAt) })
            ] }),
            /* @__PURE__ */ f.jsx("td", { children: we(N.nextRunHint) })
          ] }, D(N))) })
        ] }),
        !V.length && /* @__PURE__ */ f.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Automation。" })
      ] }),
      /* @__PURE__ */ f.jsx(li, { title: p?.name, subtitle: p?.summary, empty: "选择一个 Automation 查看配置", children: p && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Du, { items: [["Status", /* @__PURE__ */ f.jsx(Kl, { label: p.status, tone: p.status })], ["Schedule", p.schedule], ["Source", p.source], ["Repository", p.repositoryName], ["Delivery", p.delivery ?? "—"], ["Last result", p.lastResult ?? "—"], ["Last run", we(p.lastRunAt)], ["Next", we(p.nextRunHint)]] }),
        p.pausedReason && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Paused reason" }),
          /* @__PURE__ */ f.jsx("p", { children: p.pausedReason })
        ] }),
        /* @__PURE__ */ f.jsx("div", { className: "detail-button-row", children: p.actions.map((N) => /* @__PURE__ */ f.jsx(xe, { disabled: x, className: N === "pause" ? "danger-text" : "", onClick: () => {
          d(p, N);
        }, children: N === "run" ? "Run now" : N === "pause" ? "Pause" : "Resume" }, N)) }),
        /* @__PURE__ */ f.jsx("p", { className: "detail-note", children: "这里只保存调度配置与最近一次结果摘要，不复制日报、SEO 或研究正文。" })
      ] }) })
    ] })
  ] });
}
function Vv(m) {
  return m.advanced?.status ?? "";
}
function Fn(m, x) {
  const _ = Vv(m);
  return x === "all" ? !0 : x === "attention" ? _ === "blocked" || _ === "failed" : x === "completed" ? _ === "completed" || _ === "cancelled" : _ === "open" || _ === "running" || _ === "ready";
}
function Kv({ data: m, busy: x, onRefresh: _ }) {
  const d = m.workPortfolio, C = d.items ?? [], [M, X] = Sl.useState("open"), [V, O] = Sl.useState("all"), [z, D] = Sl.useState(), p = Sl.useMemo(() => C.filter((Y) => Fn(Y, M) && (V === "all" || Y.repoId === V)), [C, M, V]), N = p.find((Y) => Y.id === z) ?? p[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($e, { eyebrow: "EXECUTION WORK", title: "Work", description: "查看所有已注册仓库的持久 Work；仓库是归属维度，默认聚合展示。", refreshedAt: d.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ f.jsxs("div", { className: "toolbar work-toolbar", children: [
      /* @__PURE__ */ f.jsx(Of, { value: M, onChange: X, items: [{ id: "open", label: "Open", count: C.filter((Y) => Fn(Y, "open")).length }, { id: "attention", label: "Needs attention", count: C.filter((Y) => Fn(Y, "attention")).length }, { id: "completed", label: "Completed", count: C.filter((Y) => Fn(Y, "completed")).length }, { id: "all", label: "All", count: C.length }] }),
      /* @__PURE__ */ f.jsxs("label", { className: "repository-filter", children: [
        /* @__PURE__ */ f.jsx("span", { children: "Repository" }),
        /* @__PURE__ */ f.jsxs("select", { value: V, onChange: (Y) => {
          O(Y.target.value), D(void 0);
        }, children: [
          /* @__PURE__ */ f.jsx("option", { value: "all", children: "All repositories" }),
          d.repositories.map((Y) => /* @__PURE__ */ f.jsx("option", { value: Y.repoId, children: Y.repositoryName }, Y.repoId))
        ] })
      ] })
    ] }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "scan-list", children: [
        p.map((Y) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row work-row ${N?.id === Y.id ? "selected" : ""}`, onClick: () => D(Y.id), children: [
          /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
            /* @__PURE__ */ f.jsx("span", { className: "row-eyebrow", children: Y.repositoryName }),
            /* @__PURE__ */ f.jsx("strong", { children: Y.title }),
            /* @__PURE__ */ f.jsx("p", { children: _t(Y.latestSummary || Y.objective, 108) })
          ] }),
          /* @__PURE__ */ f.jsxs("div", { className: "scan-meta", children: [
            /* @__PURE__ */ f.jsx(Kl, { label: Y.statusLabel, tone: Y.tone }),
            /* @__PURE__ */ f.jsx("time", { children: we(Y.updatedAt) })
          ] })
        ] }, Y.id)),
        !p.length && /* @__PURE__ */ f.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Work。" })
      ] }),
      /* @__PURE__ */ f.jsx(li, { title: N?.title, subtitle: N?.objective, empty: "选择一个 Work 查看完整上下文", children: N && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Du, { items: [["Repository", N.repositoryName], ["Status", /* @__PURE__ */ f.jsx(Kl, { label: N.statusLabel, tone: N.tone })], ["Updated", we(N.updatedAt)], ["Work id", /* @__PURE__ */ f.jsx("code", { children: N.id })]] }),
        N.latestSummary && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Latest" }),
          /* @__PURE__ */ f.jsx("p", { children: N.latestSummary })
        ] }),
        /* @__PURE__ */ f.jsx("p", { className: "detail-note", children: "这里聚合所有仓库的持久 Work。具体执行、检查和继续操作仍由 ChatGPT 主控。" })
      ] }) })
    ] })
  ] });
}
function Mu(m) {
  const x = `${m.name} ${m.provider} ${(m.capabilityLabels ?? []).join(" ")}`.toLowerCase();
  return /gmail|calendar|github|google task|notion/.test(x) ? "services" : /browser|desktop|ios|repository|codegraph|local/.test(x) ? "execution" : "extensions";
}
function Jv({ data: m, busy: x, onRefresh: _ }) {
  const d = m.commandCenter.plugins ?? [], C = m.automationSettings.providers ?? [], [M, X] = Sl.useState("all"), [V, O] = Sl.useState(), z = Sl.useMemo(() => d.filter((p) => M === "all" || M === "models" || Mu(p) === M), [d, M]), D = z.find((p) => p.id === V) ?? z[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($e, { eyebrow: "CAPABILITY CATALOG", title: "Capabilities", description: "从“Forge 能做什么”查看扩展、服务、执行能力和模型，而不是浏览 MCP tool 清单。", refreshedAt: m.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ f.jsx("div", { className: "toolbar", children: /* @__PURE__ */ f.jsx(Of, { value: M, onChange: X, items: [{ id: "all", label: "All", count: d.length }, { id: "extensions", label: "Extensions", count: d.filter((p) => Mu(p) === "extensions").length }, { id: "services", label: "Services", count: d.filter((p) => Mu(p) === "services").length }, { id: "execution", label: "Execution", count: d.filter((p) => Mu(p) === "execution").length }, { id: "models", label: "Models", count: C.length }] }) }),
    M === "models" ? /* @__PURE__ */ f.jsx("div", { className: "single-list", children: /* @__PURE__ */ f.jsx("div", { className: "scan-list", children: C.map((p) => /* @__PURE__ */ f.jsxs("div", { className: "scan-row static", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
        /* @__PURE__ */ f.jsx("strong", { children: p.displayName }),
        /* @__PURE__ */ f.jsx("p", { children: _t(p.explanation ?? p.summary, 110) })
      ] }),
      /* @__PURE__ */ f.jsx(Kl, { label: p.statusLabel ?? p.status ?? "Unknown", tone: p.status })
    ] }, p.providerId)) }) }) : /* @__PURE__ */ f.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ f.jsx("div", { className: "scan-list", children: z.map((p) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row ${D?.id === p.id ? "selected" : ""}`, onClick: () => O(p.id), children: [
        /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ f.jsx("span", { className: "row-eyebrow", children: Mu(p).toUpperCase() }),
          /* @__PURE__ */ f.jsx("strong", { children: p.name }),
          /* @__PURE__ */ f.jsx("p", { children: _t(p.description, 100) })
        ] }),
        /* @__PURE__ */ f.jsx(Kl, { label: p.statusLabel ?? p.status ?? "Unknown", tone: p.status ?? p.tone })
      ] }, p.id)) }),
      /* @__PURE__ */ f.jsx(li, { title: D?.name, subtitle: D?.description, children: D && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Du, { items: [["Status", /* @__PURE__ */ f.jsx(Kl, { label: D.statusLabel ?? D.status ?? "Unknown", tone: D.status ?? D.tone })], ["Provider", D.provider ?? "—"], ["Health", D.healthLabel ?? "—"], ["Lifecycle", D.lifecycleLabel ?? "—"]] }),
        D.nextStep && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Next step" }),
          /* @__PURE__ */ f.jsx("p", { children: D.nextStep })
        ] }),
        (D.capabilityLabels ?? []).length > 0 && /* @__PURE__ */ f.jsx("div", { className: "capability-lines", children: D.capabilityLabels.map((p) => /* @__PURE__ */ f.jsx("span", { children: p }, p)) }),
        (D.warnings ?? []).map((p) => /* @__PURE__ */ f.jsx("div", { className: "detail-callout warning", children: p }, p)),
        /* @__PURE__ */ f.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced · actions & protocol" }),
          /* @__PURE__ */ f.jsx("pre", { children: Pn({ actions: D.actions, advanced: D.advanced }) })
        ] })
      ] }) })
    ] })
  ] });
}
function wv({ value: m, onChange: x, placeholder: _ = "Search…" }) {
  return /* @__PURE__ */ f.jsxs("label", { className: "search-field", children: [
    /* @__PURE__ */ f.jsx(Rv, {}),
    /* @__PURE__ */ f.jsx("input", { value: m, onChange: (d) => x(d.target.value), placeholder: _ })
  ] });
}
function $v({ data: m, busy: x, onRefresh: _, onRegister: d, onRemove: C }) {
  const M = m.commandCenter.repositories ?? [], [X, V] = Sl.useState(""), [O, z] = Sl.useState(), [D, p] = Sl.useState(""), [N, Y] = Sl.useState(""), [El, xl] = Sl.useState(!1), Nl = Sl.useMemo(() => M.filter((tl) => `${tl.name} ${tl.path} ${tl.branchLabel}`.toLowerCase().includes(X.toLowerCase())), [M, X]), cl = Nl.find((tl) => tl.id === O) ?? Nl[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($e, { eyebrow: "CONTROLLER REGISTRY", title: "Repositories", description: "查看和管理 Forge 的持久化仓库边界；临时目录不需要出现在这里。", refreshedAt: m.generatedAt, busy: x, onRefresh: _, actions: /* @__PURE__ */ f.jsx(xe, { onClick: () => xl((tl) => !tl), "aria-expanded": El, children: El ? "Cancel" : "Add repository" }) }),
    /* @__PURE__ */ f.jsxs("div", { className: "repository-tools", children: [
      /* @__PURE__ */ f.jsx(wv, { value: X, onChange: V, placeholder: "Search repositories…" }),
      /* @__PURE__ */ f.jsx("span", { className: "repository-count", children: Nl.length === M.length ? `${M.length} registered` : `${Nl.length} of ${M.length}` })
    ] }),
    El && /* @__PURE__ */ f.jsxs("form", { className: "repository-add-panel", onSubmit: (tl) => {
      tl.preventDefault(), D.trim() && d(D.trim(), N.trim() || void 0).then(() => {
        p(""), Y(""), xl(!1);
      });
    }, children: [
      /* @__PURE__ */ f.jsxs("div", { className: "repository-add-fields", children: [
        /* @__PURE__ */ f.jsxs("label", { children: [
          /* @__PURE__ */ f.jsx("span", { children: "Local path" }),
          /* @__PURE__ */ f.jsx("input", { autoFocus: !0, value: D, onChange: (tl) => p(tl.target.value), placeholder: "/absolute/path" })
        ] }),
        /* @__PURE__ */ f.jsxs("label", { children: [
          /* @__PURE__ */ f.jsx("span", { children: "Display name" }),
          /* @__PURE__ */ f.jsx("input", { value: N, onChange: (tl) => Y(tl.target.value), placeholder: "Optional" })
        ] }),
        /* @__PURE__ */ f.jsx(xe, { type: "submit", disabled: x || !D.trim(), children: "Register" })
      ] }),
      /* @__PURE__ */ f.jsx("p", { children: "只为需要持久化 Work、缓存、并发隔离或发布治理的仓库建立注册项。" })
    ] }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace repository-workspace", children: [
      /* @__PURE__ */ f.jsx("div", { className: "scan-list", children: Nl.map((tl) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row ${cl?.id === tl.id ? "selected" : ""}`, onClick: () => z(tl.id), children: [
        /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ f.jsx("strong", { children: tl.name }),
          /* @__PURE__ */ f.jsx("p", { children: _t(tl.path, 100) })
        ] }),
        /* @__PURE__ */ f.jsxs("div", { className: "scan-meta", children: [
          /* @__PURE__ */ f.jsx(Kl, { label: tl.readinessLabel ?? tl.statusLabel ?? "Registered", tone: tl.readinessLabel ?? tl.statusLabel }),
          /* @__PURE__ */ f.jsx("span", { children: tl.branchLabel ?? "—" })
        ] })
      ] }, tl.id)) }),
      /* @__PURE__ */ f.jsx(li, { title: cl?.name, subtitle: cl?.path, children: cl && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Du, { items: [["Repository id", /* @__PURE__ */ f.jsx("code", { children: cl.id })], ["Branch", cl.branchLabel ?? "—"], ["Working tree", cl.dirtyLabel ?? "—"], ["Readiness", /* @__PURE__ */ f.jsx(Kl, { label: cl.readinessLabel ?? cl.statusLabel ?? "Registered", tone: cl.readinessLabel ?? cl.statusLabel })]] }),
        /* @__PURE__ */ f.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced registry metadata" }),
          /* @__PURE__ */ f.jsx("pre", { children: Pn(cl.advanced) })
        ] }),
        /* @__PURE__ */ f.jsx("div", { className: "detail-button-row", children: /* @__PURE__ */ f.jsx(xe, { className: "danger-text", disabled: x, onClick: () => {
          C(cl.id);
        }, children: "Remove registry entry" }) })
      ] }) })
    ] })
  ] });
}
function Wv({ data: m, busy: x, onRefresh: _, onProviderAction: d, onProviderHealth: C, onToolAction: M, onToolHealth: X }) {
  const V = m.automationSettings;
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($e, { eyebrow: "LONG-LIVED CONFIG", title: "Settings", description: "模型、Provider 与本地工具的长期默认配置。Automation 调度不在这里。", refreshedAt: m.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ f.jsxs("div", { className: "settings-column", children: [
      (V.warnings ?? []).map((O) => /* @__PURE__ */ f.jsx("div", { className: "detail-callout warning", children: O }, O)),
      /* @__PURE__ */ f.jsxs("section", { children: [
        /* @__PURE__ */ f.jsx(In, { title: "Models & routing", meta: `${V.providers?.length ?? 0} providers` }),
        /* @__PURE__ */ f.jsx("div", { className: "settings-list", children: (V.providers ?? []).map((O) => /* @__PURE__ */ f.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("strong", { children: O.displayName }),
            /* @__PURE__ */ f.jsx("p", { children: _t(O.explanation ?? O.summary, 120) })
          ] }),
          /* @__PURE__ */ f.jsx(Kl, { label: O.statusLabel ?? O.status ?? "Unknown", tone: O.status }),
          /* @__PURE__ */ f.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ f.jsx(xe, { disabled: x, onClick: () => {
              C(O);
            }, children: "Check" }),
            /* @__PURE__ */ f.jsx(xe, { disabled: x, onClick: () => {
              d(O, O.enabled === !1 ? "enable" : "disable");
            }, children: O.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, O.providerId)) })
      ] }),
      /* @__PURE__ */ f.jsxs("section", { children: [
        /* @__PURE__ */ f.jsx(In, { title: "Local tools", meta: `${V.localTools?.length ?? 0} configured` }),
        /* @__PURE__ */ f.jsx("div", { className: "settings-list", children: (V.localTools ?? []).map((O) => /* @__PURE__ */ f.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("strong", { children: O.displayName }),
            /* @__PURE__ */ f.jsx("p", { children: _t(O.summary, 120) })
          ] }),
          /* @__PURE__ */ f.jsx(Kl, { label: O.status ?? (O.enabled === !1 ? "Disabled" : "Configured"), tone: O.status }),
          /* @__PURE__ */ f.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ f.jsx(xe, { disabled: x, onClick: () => {
              X(O);
            }, children: "Check" }),
            /* @__PURE__ */ f.jsx(xe, { disabled: x, onClick: () => {
              M(O, O.enabled === !1 ? "enable" : "disable");
            }, children: O.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, O.toolId)) })
      ] }),
      /* @__PURE__ */ f.jsxs("details", { className: "advanced", children: [
        /* @__PURE__ */ f.jsx("summary", { children: "Advanced routing & credentials metadata" }),
        /* @__PURE__ */ f.jsx("pre", { children: Pn({ routing: V.routing, credentials: V.credentials, overview: V.overview }) })
      ] })
    ] })
  ] });
}
function kv({ data: m, busy: x, onRefresh: _ }) {
  const [d, C] = Sl.useState(), M = m.commandCenter.readiness ?? {};
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($e, { eyebrow: "MAINTENANCE", title: "System", description: "低频工程维护入口。正常使用 Forge 不需要理解这里的运行时细节。", refreshedAt: m.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ f.jsxs("div", { className: "system-layout", children: [
      /* @__PURE__ */ f.jsxs("section", { className: "system-summary", children: [
        /* @__PURE__ */ f.jsxs("div", { className: "system-posture", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("span", { className: "eyebrow", children: "SYSTEM POSTURE" }),
            /* @__PURE__ */ f.jsx("h2", { children: Ca(M.label ?? M.headline, "Controller state") }),
            /* @__PURE__ */ f.jsx("p", { children: Ca(M.explanation ?? M.summary, "Controller and connector status") })
          ] }),
          /* @__PURE__ */ f.jsx(Kl, { label: Ca(M.state, "Unknown"), tone: Ca(M.state) })
        ] }),
        /* @__PURE__ */ f.jsx(Du, { items: [["Controller", Ca(M.label ?? M.headline, "—")], ["Connector", Ca(m.connector?.status, "—")], ["Repositories", String(m.commandCenter.repositories?.length ?? 0)], ["Plugins", String(m.commandCenter.plugins?.length ?? 0)]] })
      ] }),
      /* @__PURE__ */ f.jsxs("section", { children: [
        /* @__PURE__ */ f.jsx("button", { className: "text-button", onClick: () => {
          at.advanced().then(C);
        }, children: "Load advanced diagnostics" }),
        d && /* @__PURE__ */ f.jsxs("details", { className: "advanced", open: !0, children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced diagnostics" }),
          /* @__PURE__ */ f.jsx("pre", { children: Pn(d) })
        ] })
      ] })
    ] })
  ] });
}
async function Qr() {
  const [m, x, _, d, C, M] = await Promise.all([at.commandCenter(), at.work(), at.workPortfolio(), at.automations(), at.automationSettings(), at.connector().catch(() => {
  })]);
  return { commandCenter: m, work: x, workPortfolio: _, automations: d, automationSettings: C, connector: M, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function Fv() {
  const [m, x] = Sl.useState(Xr()), [_, d] = Sl.useState(), [C, M] = Sl.useState(!1), [X, V] = Sl.useState(""), O = Sl.useCallback(async () => {
    M(!0), V("");
    try {
      d(await Qr());
    } catch (N) {
      V(N instanceof Error ? N.message : String(N));
    } finally {
      M(!1);
    }
  }, []);
  Sl.useEffect(() => {
    O();
    const N = () => x(Xr());
    return addEventListener("hashchange", N), () => removeEventListener("hashchange", N);
  }, [O]);
  const z = Sl.useCallback(async (N) => {
    M(!0);
    try {
      await N(), d(await Qr());
    } catch (Y) {
      V(Y instanceof Error ? Y.message : String(Y));
    } finally {
      M(!1);
    }
  }, []);
  if (!_) return /* @__PURE__ */ f.jsxs("div", { className: "boot-state", children: [
    /* @__PURE__ */ f.jsx("span", { className: "brand-mark", children: "F" }),
    /* @__PURE__ */ f.jsx("strong", { children: X ? "Forge console unavailable" : "Loading Forge…" }),
    X && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
      /* @__PURE__ */ f.jsx("p", { children: X }),
      /* @__PURE__ */ f.jsx("button", { className: "button", onClick: () => {
        O();
      }, children: "Retry" })
    ] })
  ] });
  const D = { data: _, busy: C, onRefresh: () => {
    O();
  } };
  let p;
  switch (m) {
    case "automations":
      p = /* @__PURE__ */ f.jsx(Zv, { ...D, onAction: (N, Y) => z(() => at.automationAction(N.source, N.repoId, N.id, Y)) });
      break;
    case "work":
      p = /* @__PURE__ */ f.jsx(Kv, { ...D });
      break;
    case "capabilities":
      p = /* @__PURE__ */ f.jsx(Jv, { ...D });
      break;
    case "repositories":
      p = /* @__PURE__ */ f.jsx($v, { ...D, onRegister: (N, Y) => z(() => at.registerRepository(N, Y)), onRemove: (N) => z(() => at.removeRepository(N)) });
      break;
    case "settings":
      p = /* @__PURE__ */ f.jsx(Wv, { ...D, onProviderAction: (N, Y) => z(() => at.providerAction(N.providerId, Y)), onProviderHealth: (N) => z(() => at.providerHealth(N.providerId)), onToolAction: (N, Y) => z(() => at.localToolAction(N.toolId, Y)), onToolHealth: (N) => z(() => at.localToolHealth(N.toolId)) });
      break;
    case "system":
      p = /* @__PURE__ */ f.jsx(kv, { ...D });
      break;
    default:
      p = /* @__PURE__ */ f.jsx(Qv, { ...D });
  }
  return /* @__PURE__ */ f.jsxs(Bv, { route: m, children: [
    X && /* @__PURE__ */ f.jsxs("div", { className: "global-error", children: [
      /* @__PURE__ */ f.jsx("strong", { children: "Last action failed" }),
      /* @__PURE__ */ f.jsx("span", { children: X }),
      /* @__PURE__ */ f.jsx("button", { onClick: () => V(""), children: "×" })
    ] }),
    p
  ] });
}
const Vr = document.getElementById("app");
if (!Vr) throw new Error("Forge console root missing");
Tv.createRoot(Vr).render(/* @__PURE__ */ f.jsx(Sl.StrictMode, { children: /* @__PURE__ */ f.jsx(Fv, {}) }));
