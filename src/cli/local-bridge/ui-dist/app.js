var bf = { exports: {} }, Nu = {};
var Mr;
function vy() {
  if (Mr) return Nu;
  Mr = 1;
  var o = /* @__PURE__ */ Symbol.for("react.transitional.element"), E = /* @__PURE__ */ Symbol.for("react.fragment");
  function _(m, C, D) {
    var Q = null;
    if (D !== void 0 && (Q = "" + D), C.key !== void 0 && (Q = "" + C.key), "key" in C) {
      D = {};
      for (var W in C)
        W !== "key" && (D[W] = C[W]);
    } else D = C;
    return C = D.ref, {
      $$typeof: o,
      type: m,
      key: Q,
      ref: C !== void 0 ? C : null,
      props: D
    };
  }
  return Nu.Fragment = E, Nu.jsx = _, Nu.jsxs = _, Nu;
}
var Dr;
function gy() {
  return Dr || (Dr = 1, bf.exports = vy()), bf.exports;
}
var f = gy(), Sf = { exports: {} }, V = {};
var Ur;
function by() {
  if (Ur) return V;
  Ur = 1;
  var o = /* @__PURE__ */ Symbol.for("react.transitional.element"), E = /* @__PURE__ */ Symbol.for("react.portal"), _ = /* @__PURE__ */ Symbol.for("react.fragment"), m = /* @__PURE__ */ Symbol.for("react.strict_mode"), C = /* @__PURE__ */ Symbol.for("react.profiler"), D = /* @__PURE__ */ Symbol.for("react.consumer"), Q = /* @__PURE__ */ Symbol.for("react.context"), W = /* @__PURE__ */ Symbol.for("react.forward_ref"), M = /* @__PURE__ */ Symbol.for("react.suspense"), S = /* @__PURE__ */ Symbol.for("react.memo"), O = /* @__PURE__ */ Symbol.for("react.lazy"), T = /* @__PURE__ */ Symbol.for("react.activity"), q = Symbol.iterator;
  function N(r) {
    return r === null || typeof r != "object" ? null : (r = q && r[q] || r["@@iterator"], typeof r == "function" ? r : null);
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
  function cl(r, x, R) {
    this.props = r, this.context = x, this.refs = Nl, this.updater = R || El;
  }
  cl.prototype.isReactComponent = {}, cl.prototype.setState = function(r, x) {
    if (typeof r != "object" && typeof r != "function" && r != null)
      throw Error(
        "takes an object of state variables to update or a function which returns an object of state variables."
      );
    this.updater.enqueueSetState(this, r, x, "setState");
  }, cl.prototype.forceUpdate = function(r) {
    this.updater.enqueueForceUpdate(this, r, "forceUpdate");
  };
  function tl() {
  }
  tl.prototype = cl.prototype;
  function Rl(r, x, R) {
    this.props = r, this.context = x, this.refs = Nl, this.updater = R || El;
  }
  var Kl = Rl.prototype = new tl();
  Kl.constructor = Rl, xl(Kl, cl.prototype), Kl.isPureReactComponent = !0;
  var rt = Array.isArray;
  function X() {
  }
  var w = { H: null, A: null, T: null, S: null }, Cl = Object.prototype.hasOwnProperty;
  function Jl(r, x, R) {
    var B = R.ref;
    return {
      $$typeof: o,
      type: r,
      key: x,
      ref: B !== void 0 ? B : null,
      props: R
    };
  }
  function we(r, x) {
    return Jl(r.type, x, r.props);
  }
  function Nt(r) {
    return typeof r == "object" && r !== null && r.$$typeof === o;
  }
  function wl(r) {
    var x = { "=": "=0", ":": "=2" };
    return "$" + r.replace(/[=:]/g, function(R) {
      return x[R];
    });
  }
  var xe = /\/+/g;
  function Ut(r, x) {
    return typeof r == "object" && r !== null && r.key != null ? wl("" + r.key) : x.toString(36);
  }
  function Tt(r) {
    switch (r.status) {
      case "fulfilled":
        return r.value;
      case "rejected":
        throw r.reason;
      default:
        switch (typeof r.status == "string" ? r.then(X, X) : (r.status = "pending", r.then(
          function(x) {
            r.status === "pending" && (r.status = "fulfilled", r.value = x);
          },
          function(x) {
            r.status === "pending" && (r.status = "rejected", r.reason = x);
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
  function A(r, x, R, B, K) {
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
            case o:
            case E:
              il = !0;
              break;
            case O:
              return il = r._init, A(
                il(r._payload),
                x,
                R,
                B,
                K
              );
          }
      }
    if (il)
      return K = K(r), il = B === "" ? "." + Ut(r, 0) : B, rt(K) ? (R = "", il != null && (R = il.replace(xe, "$&/") + "/"), A(K, x, R, "", function(Ca) {
        return Ca;
      })) : K != null && (Nt(K) && (K = we(
        K,
        R + (K.key == null || r && r.key === K.key ? "" : ("" + K.key).replace(
          xe,
          "$&/"
        ) + "/") + il
      )), x.push(K)), 1;
    il = 0;
    var Zl = B === "" ? "." : B + ":";
    if (rt(r))
      for (var zl = 0; zl < r.length; zl++)
        B = r[zl], k = Zl + Ut(B, zl), il += A(
          B,
          x,
          R,
          k,
          K
        );
    else if (zl = N(r), typeof zl == "function")
      for (r = zl.call(r), zl = 0; !(B = r.next()).done; )
        B = B.value, k = Zl + Ut(B, zl++), il += A(
          B,
          x,
          R,
          k,
          K
        );
    else if (k === "object") {
      if (typeof r.then == "function")
        return A(
          Tt(r),
          x,
          R,
          B,
          K
        );
      throw x = String(r), Error(
        "Objects are not valid as a React child (found: " + (x === "[object Object]" ? "object with keys {" + Object.keys(r).join(", ") + "}" : x) + "). If you meant to render a collection of children, use an array instead."
      );
    }
    return il;
  }
  function U(r, x, R) {
    if (r == null) return r;
    var B = [], K = 0;
    return A(r, B, "", "", function(k) {
      return x.call(R, k, K++);
    }), B;
  }
  function Z(r) {
    if (r._status === -1) {
      var x = r._result;
      x = x(), x.then(
        function(R) {
          (r._status === 0 || r._status === -1) && (r._status = 1, r._result = R);
        },
        function(R) {
          (r._status === 0 || r._status === -1) && (r._status = 2, r._result = R);
        }
      ), r._status === -1 && (r._status = 0, r._result = x);
    }
    if (r._status === 1) return r._result.default;
    throw r._result;
  }
  var ol = typeof reportError == "function" ? reportError : function(r) {
    if (typeof window == "object" && typeof window.ErrorEvent == "function") {
      var x = new window.ErrorEvent("error", {
        bubbles: !0,
        cancelable: !0,
        message: typeof r == "object" && r !== null && typeof r.message == "string" ? String(r.message) : String(r),
        error: r
      });
      if (!window.dispatchEvent(x)) return;
    } else if (typeof process == "object" && typeof process.emit == "function") {
      process.emit("uncaughtException", r);
      return;
    }
    console.error(r);
  }, hl = {
    map: U,
    forEach: function(r, x, R) {
      U(
        r,
        function() {
          x.apply(this, arguments);
        },
        R
      );
    },
    count: function(r) {
      var x = 0;
      return U(r, function() {
        x++;
      }), x;
    },
    toArray: function(r) {
      return U(r, function(x) {
        return x;
      }) || [];
    },
    only: function(r) {
      if (!Nt(r))
        throw Error(
          "React.Children.only expected to receive a single React element child."
        );
      return r;
    }
  };
  return V.Activity = T, V.Children = hl, V.Component = cl, V.Fragment = _, V.Profiler = C, V.PureComponent = Rl, V.StrictMode = m, V.Suspense = M, V.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = w, V.__COMPILER_RUNTIME = {
    __proto__: null,
    c: function(r) {
      return w.H.useMemoCache(r);
    }
  }, V.cache = function(r) {
    return function() {
      return r.apply(null, arguments);
    };
  }, V.cacheSignal = function() {
    return null;
  }, V.cloneElement = function(r, x, R) {
    if (r == null)
      throw Error(
        "The argument must be a React element, but you passed " + r + "."
      );
    var B = xl({}, r.props), K = r.key;
    if (x != null)
      for (k in x.key !== void 0 && (K = "" + x.key), x)
        !Cl.call(x, k) || k === "key" || k === "__self" || k === "__source" || k === "ref" && x.ref === void 0 || (B[k] = x[k]);
    var k = arguments.length - 2;
    if (k === 1) B.children = R;
    else if (1 < k) {
      for (var il = Array(k), Zl = 0; Zl < k; Zl++)
        il[Zl] = arguments[Zl + 2];
      B.children = il;
    }
    return Jl(r.type, K, B);
  }, V.createContext = function(r) {
    return r = {
      $$typeof: Q,
      _currentValue: r,
      _currentValue2: r,
      _threadCount: 0,
      Provider: null,
      Consumer: null
    }, r.Provider = r, r.Consumer = {
      $$typeof: D,
      _context: r
    }, r;
  }, V.createElement = function(r, x, R) {
    var B, K = {}, k = null;
    if (x != null)
      for (B in x.key !== void 0 && (k = "" + x.key), x)
        Cl.call(x, B) && B !== "key" && B !== "__self" && B !== "__source" && (K[B] = x[B]);
    var il = arguments.length - 2;
    if (il === 1) K.children = R;
    else if (1 < il) {
      for (var Zl = Array(il), zl = 0; zl < il; zl++)
        Zl[zl] = arguments[zl + 2];
      K.children = Zl;
    }
    if (r && r.defaultProps)
      for (B in il = r.defaultProps, il)
        K[B] === void 0 && (K[B] = il[B]);
    return Jl(r, k, K);
  }, V.createRef = function() {
    return { current: null };
  }, V.forwardRef = function(r) {
    return { $$typeof: W, render: r };
  }, V.isValidElement = Nt, V.lazy = function(r) {
    return {
      $$typeof: O,
      _payload: { _status: -1, _result: r },
      _init: Z
    };
  }, V.memo = function(r, x) {
    return {
      $$typeof: S,
      type: r,
      compare: x === void 0 ? null : x
    };
  }, V.startTransition = function(r) {
    var x = w.T, R = {};
    w.T = R;
    try {
      var B = r(), K = w.S;
      K !== null && K(R, B), typeof B == "object" && B !== null && typeof B.then == "function" && B.then(X, ol);
    } catch (k) {
      ol(k);
    } finally {
      x !== null && R.types !== null && (x.types = R.types), w.T = x;
    }
  }, V.unstable_useCacheRefresh = function() {
    return w.H.useCacheRefresh();
  }, V.use = function(r) {
    return w.H.use(r);
  }, V.useActionState = function(r, x, R) {
    return w.H.useActionState(r, x, R);
  }, V.useCallback = function(r, x) {
    return w.H.useCallback(r, x);
  }, V.useContext = function(r) {
    return w.H.useContext(r);
  }, V.useDebugValue = function() {
  }, V.useDeferredValue = function(r, x) {
    return w.H.useDeferredValue(r, x);
  }, V.useEffect = function(r, x) {
    return w.H.useEffect(r, x);
  }, V.useEffectEvent = function(r) {
    return w.H.useEffectEvent(r);
  }, V.useId = function() {
    return w.H.useId();
  }, V.useImperativeHandle = function(r, x, R) {
    return w.H.useImperativeHandle(r, x, R);
  }, V.useInsertionEffect = function(r, x) {
    return w.H.useInsertionEffect(r, x);
  }, V.useLayoutEffect = function(r, x) {
    return w.H.useLayoutEffect(r, x);
  }, V.useMemo = function(r, x) {
    return w.H.useMemo(r, x);
  }, V.useOptimistic = function(r, x) {
    return w.H.useOptimistic(r, x);
  }, V.useReducer = function(r, x, R) {
    return w.H.useReducer(r, x, R);
  }, V.useRef = function(r) {
    return w.H.useRef(r);
  }, V.useState = function(r) {
    return w.H.useState(r);
  }, V.useSyncExternalStore = function(r, x, R) {
    return w.H.useSyncExternalStore(
      r,
      x,
      R
    );
  }, V.useTransition = function() {
    return w.H.useTransition();
  }, V.version = "19.2.8", V;
}
var Rr;
function Ef() {
  return Rr || (Rr = 1, Sf.exports = by()), Sf.exports;
}
var bl = Ef(), pf = { exports: {} }, Ou = {}, Af = { exports: {} }, zf = {};
var Cr;
function Sy() {
  return Cr || (Cr = 1, (function(o) {
    function E(A, U) {
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
    function m(A) {
      if (A.length === 0) return null;
      var U = A[0], Z = A.pop();
      if (Z !== U) {
        A[0] = Z;
        l: for (var ol = 0, hl = A.length, r = hl >>> 1; ol < r; ) {
          var x = 2 * (ol + 1) - 1, R = A[x], B = x + 1, K = A[B];
          if (0 > C(R, Z))
            B < hl && 0 > C(K, R) ? (A[ol] = K, A[B] = Z, ol = B) : (A[ol] = R, A[x] = Z, ol = x);
          else if (B < hl && 0 > C(K, Z))
            A[ol] = K, A[B] = Z, ol = B;
          else break l;
        }
      }
      return U;
    }
    function C(A, U) {
      var Z = A.sortIndex - U.sortIndex;
      return Z !== 0 ? Z : A.id - U.id;
    }
    if (o.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
      var D = performance;
      o.unstable_now = function() {
        return D.now();
      };
    } else {
      var Q = Date, W = Q.now();
      o.unstable_now = function() {
        return Q.now() - W;
      };
    }
    var M = [], S = [], O = 1, T = null, q = 3, N = !1, El = !1, xl = !1, Nl = !1, cl = typeof setTimeout == "function" ? setTimeout : null, tl = typeof clearTimeout == "function" ? clearTimeout : null, Rl = typeof setImmediate < "u" ? setImmediate : null;
    function Kl(A) {
      for (var U = _(S); U !== null; ) {
        if (U.callback === null) m(S);
        else if (U.startTime <= A)
          m(S), U.sortIndex = U.expirationTime, E(M, U);
        else break;
        U = _(S);
      }
    }
    function rt(A) {
      if (xl = !1, Kl(A), !El)
        if (_(M) !== null)
          El = !0, X || (X = !0, wl());
        else {
          var U = _(S);
          U !== null && Tt(rt, U.startTime - A);
        }
    }
    var X = !1, w = -1, Cl = 5, Jl = -1;
    function we() {
      return Nl ? !0 : !(o.unstable_now() - Jl < Cl);
    }
    function Nt() {
      if (Nl = !1, X) {
        var A = o.unstable_now();
        Jl = A;
        var U = !0;
        try {
          l: {
            El = !1, xl && (xl = !1, tl(w), w = -1), N = !0;
            var Z = q;
            try {
              t: {
                for (Kl(A), T = _(M); T !== null && !(T.expirationTime > A && we()); ) {
                  var ol = T.callback;
                  if (typeof ol == "function") {
                    T.callback = null, q = T.priorityLevel;
                    var hl = ol(
                      T.expirationTime <= A
                    );
                    if (A = o.unstable_now(), typeof hl == "function") {
                      T.callback = hl, Kl(A), U = !0;
                      break t;
                    }
                    T === _(M) && m(M), Kl(A);
                  } else m(M);
                  T = _(M);
                }
                if (T !== null) U = !0;
                else {
                  var r = _(S);
                  r !== null && Tt(
                    rt,
                    r.startTime - A
                  ), U = !1;
                }
              }
              break l;
            } finally {
              T = null, q = Z, N = !1;
            }
            U = void 0;
          }
        } finally {
          U ? wl() : X = !1;
        }
      }
    }
    var wl;
    if (typeof Rl == "function")
      wl = function() {
        Rl(Nt);
      };
    else if (typeof MessageChannel < "u") {
      var xe = new MessageChannel(), Ut = xe.port2;
      xe.port1.onmessage = Nt, wl = function() {
        Ut.postMessage(null);
      };
    } else
      wl = function() {
        cl(Nt, 0);
      };
    function Tt(A, U) {
      w = cl(function() {
        A(o.unstable_now());
      }, U);
    }
    o.unstable_IdlePriority = 5, o.unstable_ImmediatePriority = 1, o.unstable_LowPriority = 4, o.unstable_NormalPriority = 3, o.unstable_Profiling = null, o.unstable_UserBlockingPriority = 2, o.unstable_cancelCallback = function(A) {
      A.callback = null;
    }, o.unstable_forceFrameRate = function(A) {
      0 > A || 125 < A ? console.error(
        "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
      ) : Cl = 0 < A ? Math.floor(1e3 / A) : 5;
    }, o.unstable_getCurrentPriorityLevel = function() {
      return q;
    }, o.unstable_next = function(A) {
      switch (q) {
        case 1:
        case 2:
        case 3:
          var U = 3;
          break;
        default:
          U = q;
      }
      var Z = q;
      q = U;
      try {
        return A();
      } finally {
        q = Z;
      }
    }, o.unstable_requestPaint = function() {
      Nl = !0;
    }, o.unstable_runWithPriority = function(A, U) {
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
      var Z = q;
      q = A;
      try {
        return U();
      } finally {
        q = Z;
      }
    }, o.unstable_scheduleCallback = function(A, U, Z) {
      var ol = o.unstable_now();
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
        id: O++,
        callback: U,
        priorityLevel: A,
        startTime: Z,
        expirationTime: hl,
        sortIndex: -1
      }, Z > ol ? (A.sortIndex = Z, E(S, A), _(M) === null && A === _(S) && (xl ? (tl(w), w = -1) : xl = !0, Tt(rt, Z - ol))) : (A.sortIndex = hl, E(M, A), El || N || (El = !0, X || (X = !0, wl()))), A;
    }, o.unstable_shouldYield = we, o.unstable_wrapCallback = function(A) {
      var U = q;
      return function() {
        var Z = q;
        q = U;
        try {
          return A.apply(this, arguments);
        } finally {
          q = Z;
        }
      };
    };
  })(zf)), zf;
}
var Hr;
function py() {
  return Hr || (Hr = 1, Af.exports = Sy()), Af.exports;
}
var Tf = { exports: {} }, Xl = {};
var qr;
function Ay() {
  if (qr) return Xl;
  qr = 1;
  var o = Ef();
  function E(M) {
    var S = "https://react.dev/errors/" + M;
    if (1 < arguments.length) {
      S += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var O = 2; O < arguments.length; O++)
        S += "&args[]=" + encodeURIComponent(arguments[O]);
    }
    return "Minified React error #" + M + "; visit " + S + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function _() {
  }
  var m = {
    d: {
      f: _,
      r: function() {
        throw Error(E(522));
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
  function D(M, S, O) {
    var T = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: C,
      key: T == null ? null : "" + T,
      children: M,
      containerInfo: S,
      implementation: O
    };
  }
  var Q = o.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function W(M, S) {
    if (M === "font") return "";
    if (typeof S == "string")
      return S === "use-credentials" ? S : "";
  }
  return Xl.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = m, Xl.createPortal = function(M, S) {
    var O = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!S || S.nodeType !== 1 && S.nodeType !== 9 && S.nodeType !== 11)
      throw Error(E(299));
    return D(M, S, null, O);
  }, Xl.flushSync = function(M) {
    var S = Q.T, O = m.p;
    try {
      if (Q.T = null, m.p = 2, M) return M();
    } finally {
      Q.T = S, m.p = O, m.d.f();
    }
  }, Xl.preconnect = function(M, S) {
    typeof M == "string" && (S ? (S = S.crossOrigin, S = typeof S == "string" ? S === "use-credentials" ? S : "" : void 0) : S = null, m.d.C(M, S));
  }, Xl.prefetchDNS = function(M) {
    typeof M == "string" && m.d.D(M);
  }, Xl.preinit = function(M, S) {
    if (typeof M == "string" && S && typeof S.as == "string") {
      var O = S.as, T = W(O, S.crossOrigin), q = typeof S.integrity == "string" ? S.integrity : void 0, N = typeof S.fetchPriority == "string" ? S.fetchPriority : void 0;
      O === "style" ? m.d.S(
        M,
        typeof S.precedence == "string" ? S.precedence : void 0,
        {
          crossOrigin: T,
          integrity: q,
          fetchPriority: N
        }
      ) : O === "script" && m.d.X(M, {
        crossOrigin: T,
        integrity: q,
        fetchPriority: N,
        nonce: typeof S.nonce == "string" ? S.nonce : void 0
      });
    }
  }, Xl.preinitModule = function(M, S) {
    if (typeof M == "string")
      if (typeof S == "object" && S !== null) {
        if (S.as == null || S.as === "script") {
          var O = W(
            S.as,
            S.crossOrigin
          );
          m.d.M(M, {
            crossOrigin: O,
            integrity: typeof S.integrity == "string" ? S.integrity : void 0,
            nonce: typeof S.nonce == "string" ? S.nonce : void 0
          });
        }
      } else S == null && m.d.M(M);
  }, Xl.preload = function(M, S) {
    if (typeof M == "string" && typeof S == "object" && S !== null && typeof S.as == "string") {
      var O = S.as, T = W(O, S.crossOrigin);
      m.d.L(M, O, {
        crossOrigin: T,
        integrity: typeof S.integrity == "string" ? S.integrity : void 0,
        nonce: typeof S.nonce == "string" ? S.nonce : void 0,
        type: typeof S.type == "string" ? S.type : void 0,
        fetchPriority: typeof S.fetchPriority == "string" ? S.fetchPriority : void 0,
        referrerPolicy: typeof S.referrerPolicy == "string" ? S.referrerPolicy : void 0,
        imageSrcSet: typeof S.imageSrcSet == "string" ? S.imageSrcSet : void 0,
        imageSizes: typeof S.imageSizes == "string" ? S.imageSizes : void 0,
        media: typeof S.media == "string" ? S.media : void 0
      });
    }
  }, Xl.preloadModule = function(M, S) {
    if (typeof M == "string")
      if (S) {
        var O = W(S.as, S.crossOrigin);
        m.d.m(M, {
          as: typeof S.as == "string" && S.as !== "script" ? S.as : void 0,
          crossOrigin: O,
          integrity: typeof S.integrity == "string" ? S.integrity : void 0
        });
      } else m.d.m(M);
  }, Xl.requestFormReset = function(M) {
    m.d.r(M);
  }, Xl.unstable_batchedUpdates = function(M, S) {
    return M(S);
  }, Xl.useFormState = function(M, S, O) {
    return Q.H.useFormState(M, S, O);
  }, Xl.useFormStatus = function() {
    return Q.H.useHostTransitionStatus();
  }, Xl.version = "19.2.8", Xl;
}
var Br;
function zy() {
  if (Br) return Tf.exports;
  Br = 1;
  function o() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(o);
      } catch (E) {
        console.error(E);
      }
  }
  return o(), Tf.exports = Ay(), Tf.exports;
}
var Yr;
function Ty() {
  if (Yr) return Ou;
  Yr = 1;
  var o = py(), E = Ef(), _ = zy();
  function m(l) {
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
  function D(l) {
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
  function Q(l) {
    if (l.tag === 13) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function W(l) {
    if (l.tag === 31) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function M(l) {
    if (D(l) !== l)
      throw Error(m(188));
  }
  function S(l) {
    var t = l.alternate;
    if (!t) {
      if (t = D(l), t === null) throw Error(m(188));
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
          if (n === e) return M(u), l;
          if (n === a) return M(u), t;
          n = n.sibling;
        }
        throw Error(m(188));
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
          if (!i) throw Error(m(189));
        }
      }
      if (e.alternate !== a) throw Error(m(190));
    }
    if (e.tag !== 3) throw Error(m(188));
    return e.stateNode.current === e ? l : t;
  }
  function O(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l;
    for (l = l.child; l !== null; ) {
      if (t = O(l), t !== null) return t;
      l = l.sibling;
    }
    return null;
  }
  var T = Object.assign, q = /* @__PURE__ */ Symbol.for("react.element"), N = /* @__PURE__ */ Symbol.for("react.transitional.element"), El = /* @__PURE__ */ Symbol.for("react.portal"), xl = /* @__PURE__ */ Symbol.for("react.fragment"), Nl = /* @__PURE__ */ Symbol.for("react.strict_mode"), cl = /* @__PURE__ */ Symbol.for("react.profiler"), tl = /* @__PURE__ */ Symbol.for("react.consumer"), Rl = /* @__PURE__ */ Symbol.for("react.context"), Kl = /* @__PURE__ */ Symbol.for("react.forward_ref"), rt = /* @__PURE__ */ Symbol.for("react.suspense"), X = /* @__PURE__ */ Symbol.for("react.suspense_list"), w = /* @__PURE__ */ Symbol.for("react.memo"), Cl = /* @__PURE__ */ Symbol.for("react.lazy"), Jl = /* @__PURE__ */ Symbol.for("react.activity"), we = /* @__PURE__ */ Symbol.for("react.memo_cache_sentinel"), Nt = Symbol.iterator;
  function wl(l) {
    return l === null || typeof l != "object" ? null : (l = Nt && l[Nt] || l["@@iterator"], typeof l == "function" ? l : null);
  }
  var xe = /* @__PURE__ */ Symbol.for("react.client.reference");
  function Ut(l) {
    if (l == null) return null;
    if (typeof l == "function")
      return l.$$typeof === xe ? null : l.displayName || l.name || null;
    if (typeof l == "string") return l;
    switch (l) {
      case xl:
        return "Fragment";
      case cl:
        return "Profiler";
      case Nl:
        return "StrictMode";
      case rt:
        return "Suspense";
      case X:
        return "SuspenseList";
      case Jl:
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
        case Kl:
          var t = l.render;
          return l = l.displayName, l || (l = t.displayName || t.name || "", l = l !== "" ? "ForwardRef(" + l + ")" : "ForwardRef"), l;
        case w:
          return t = l.displayName || null, t !== null ? t : Ut(l.type) || "Memo";
        case Cl:
          t = l._payload, l = l._init;
          try {
            return Ut(l(t));
          } catch {
          }
      }
    return null;
  }
  var Tt = Array.isArray, A = E.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, U = _.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, Z = {
    pending: !1,
    data: null,
    method: null,
    action: null
  }, ol = [], hl = -1;
  function r(l) {
    return { current: l };
  }
  function x(l) {
    0 > hl || (l.current = ol[hl], ol[hl] = null, hl--);
  }
  function R(l, t) {
    hl++, ol[hl] = l.current, l.current = t;
  }
  var B = r(null), K = r(null), k = r(null), il = r(null);
  function Zl(l, t) {
    switch (R(k, t), R(K, l), R(B, null), t.nodeType) {
      case 9:
      case 11:
        l = (l = t.documentElement) && (l = l.namespaceURI) ? Pd(l) : 0;
        break;
      default:
        if (l = t.tagName, t = t.namespaceURI)
          t = Pd(t), l = lr(t, l);
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
    x(B), R(B, l);
  }
  function zl() {
    x(B), x(K), x(k);
  }
  function Ca(l) {
    l.memoizedState !== null && R(il, l);
    var t = B.current, e = lr(t, l.type);
    t !== e && (R(K, l), R(B, e));
  }
  function Du(l) {
    K.current === l && (x(B), x(K)), il.current === l && (x(il), Tu._currentValue = Z);
  }
  var Pn, Of;
  function Ne(l) {
    if (Pn === void 0)
      try {
        throw Error();
      } catch (e) {
        var t = e.stack.trim().match(/\n( *(at )?)/);
        Pn = t && t[1] || "", Of = -1 < e.stack.indexOf(`
    at`) ? " (<anonymous>)" : -1 < e.stack.indexOf("@") ? "@unknown:0:0" : "";
      }
    return `
` + Pn + l + Of;
  }
  var li = !1;
  function ti(l, t) {
    if (!l || li) return "";
    li = !0;
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
                } catch (b) {
                  var g = b;
                }
                Reflect.construct(l, [], j);
              } else {
                try {
                  j.call();
                } catch (b) {
                  g = b;
                }
                l.call(j.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (b) {
                g = b;
              }
              (j = l()) && typeof j.catch == "function" && j.catch(function() {
              });
            }
          } catch (b) {
            if (b && g && typeof b.stack == "string")
              return [b.stack, g.stack];
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
`), v = c.split(`
`);
        for (u = a = 0; a < s.length && !s[a].includes("DetermineComponentFrameRoot"); )
          a++;
        for (; u < v.length && !v[u].includes(
          "DetermineComponentFrameRoot"
        ); )
          u++;
        if (a === s.length || u === v.length)
          for (a = s.length - 1, u = v.length - 1; 1 <= a && 0 <= u && s[a] !== v[u]; )
            u--;
        for (; 1 <= a && 0 <= u; a--, u--)
          if (s[a] !== v[u]) {
            if (a !== 1 || u !== 1)
              do
                if (a--, u--, 0 > u || s[a] !== v[u]) {
                  var p = `
` + s[a].replace(" at new ", " at ");
                  return l.displayName && p.includes("<anonymous>") && (p = p.replace("<anonymous>", l.displayName)), p;
                }
              while (1 <= a && 0 <= u);
            break;
          }
      }
    } finally {
      li = !1, Error.prepareStackTrace = e;
    }
    return (e = l ? l.displayName || l.name : "") ? Ne(e) : "";
  }
  function wr(l, t) {
    switch (l.tag) {
      case 26:
      case 27:
      case 5:
        return Ne(l.type);
      case 16:
        return Ne("Lazy");
      case 13:
        return l.child !== t && t !== null ? Ne("Suspense Fallback") : Ne("Suspense");
      case 19:
        return Ne("SuspenseList");
      case 0:
      case 15:
        return ti(l.type, !1);
      case 11:
        return ti(l.type.render, !1);
      case 1:
        return ti(l.type, !0);
      case 31:
        return Ne("Activity");
      default:
        return "";
    }
  }
  function _f(l) {
    try {
      var t = "", e = null;
      do
        t += wr(l, e), e = l, l = l.return;
      while (l);
      return t;
    } catch (a) {
      return `
Error generating stack: ` + a.message + `
` + a.stack;
    }
  }
  var ei = Object.prototype.hasOwnProperty, ai = o.unstable_scheduleCallback, ui = o.unstable_cancelCallback, $r = o.unstable_shouldYield, Wr = o.unstable_requestPaint, tt = o.unstable_now, kr = o.unstable_getCurrentPriorityLevel, Mf = o.unstable_ImmediatePriority, Df = o.unstable_UserBlockingPriority, Uu = o.unstable_NormalPriority, Fr = o.unstable_LowPriority, Uf = o.unstable_IdlePriority, Ir = o.log, Pr = o.unstable_setDisableYieldValue, Ha = null, et = null;
  function le(l) {
    if (typeof Ir == "function" && Pr(l), et && typeof et.setStrictMode == "function")
      try {
        et.setStrictMode(Ha, l);
      } catch {
      }
  }
  var at = Math.clz32 ? Math.clz32 : em, lm = Math.log, tm = Math.LN2;
  function em(l) {
    return l >>>= 0, l === 0 ? 32 : 31 - (lm(l) / tm | 0) | 0;
  }
  var Ru = 256, Cu = 262144, Hu = 4194304;
  function Oe(l) {
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
  function qu(l, t, e) {
    var a = l.pendingLanes;
    if (a === 0) return 0;
    var u = 0, n = l.suspendedLanes, i = l.pingedLanes;
    l = l.warmLanes;
    var c = a & 134217727;
    return c !== 0 ? (a = c & ~n, a !== 0 ? u = Oe(a) : (i &= c, i !== 0 ? u = Oe(i) : e || (e = c & ~l, e !== 0 && (u = Oe(e))))) : (c = a & ~n, c !== 0 ? u = Oe(c) : i !== 0 ? u = Oe(i) : e || (e = a & ~l, e !== 0 && (u = Oe(e)))), u === 0 ? 0 : t !== 0 && t !== u && (t & n) === 0 && (n = u & -u, e = t & -t, n >= e || n === 32 && (e & 4194048) !== 0) ? t : u;
  }
  function qa(l, t) {
    return (l.pendingLanes & ~(l.suspendedLanes & ~l.pingedLanes) & t) === 0;
  }
  function am(l, t) {
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
  function Rf() {
    var l = Hu;
    return Hu <<= 1, (Hu & 62914560) === 0 && (Hu = 4194304), l;
  }
  function ni(l) {
    for (var t = [], e = 0; 31 > e; e++) t.push(l);
    return t;
  }
  function Ba(l, t) {
    l.pendingLanes |= t, t !== 268435456 && (l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0);
  }
  function um(l, t, e, a, u, n) {
    var i = l.pendingLanes;
    l.pendingLanes = e, l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0, l.expiredLanes &= e, l.entangledLanes &= e, l.errorRecoveryDisabledLanes &= e, l.shellSuspendCounter = 0;
    var c = l.entanglements, s = l.expirationTimes, v = l.hiddenUpdates;
    for (e = i & ~e; 0 < e; ) {
      var p = 31 - at(e), j = 1 << p;
      c[p] = 0, s[p] = -1;
      var g = v[p];
      if (g !== null)
        for (v[p] = null, p = 0; p < g.length; p++) {
          var b = g[p];
          b !== null && (b.lane &= -536870913);
        }
      e &= ~j;
    }
    a !== 0 && Cf(l, a, 0), n !== 0 && u === 0 && l.tag !== 0 && (l.suspendedLanes |= n & ~(i & ~t));
  }
  function Cf(l, t, e) {
    l.pendingLanes |= t, l.suspendedLanes &= ~t;
    var a = 31 - at(t);
    l.entangledLanes |= t, l.entanglements[a] = l.entanglements[a] | 1073741824 | e & 261930;
  }
  function Hf(l, t) {
    var e = l.entangledLanes |= t;
    for (l = l.entanglements; e; ) {
      var a = 31 - at(e), u = 1 << a;
      u & t | l[a] & t && (l[a] |= t), e &= ~u;
    }
  }
  function qf(l, t) {
    var e = t & -t;
    return e = (e & 42) !== 0 ? 1 : ii(e), (e & (l.suspendedLanes | t)) !== 0 ? 0 : e;
  }
  function ii(l) {
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
  function ci(l) {
    return l &= -l, 2 < l ? 8 < l ? (l & 134217727) !== 0 ? 32 : 268435456 : 8 : 2;
  }
  function Bf() {
    var l = U.p;
    return l !== 0 ? l : (l = window.event, l === void 0 ? 32 : Tr(l.type));
  }
  function Yf(l, t) {
    var e = U.p;
    try {
      return U.p = l, t();
    } finally {
      U.p = e;
    }
  }
  var te = Math.random().toString(36).slice(2), Bl = "__reactFiber$" + te, $l = "__reactProps$" + te, $e = "__reactContainer$" + te, fi = "__reactEvents$" + te, nm = "__reactListeners$" + te, im = "__reactHandles$" + te, Gf = "__reactResources$" + te, Ya = "__reactMarker$" + te;
  function si(l) {
    delete l[Bl], delete l[$l], delete l[fi], delete l[nm], delete l[im];
  }
  function We(l) {
    var t = l[Bl];
    if (t) return t;
    for (var e = l.parentNode; e; ) {
      if (t = e[$e] || e[Bl]) {
        if (e = t.alternate, t.child !== null || e !== null && e.child !== null)
          for (l = cr(l); l !== null; ) {
            if (e = l[Bl]) return e;
            l = cr(l);
          }
        return t;
      }
      l = e, e = l.parentNode;
    }
    return null;
  }
  function ke(l) {
    if (l = l[Bl] || l[$e]) {
      var t = l.tag;
      if (t === 5 || t === 6 || t === 13 || t === 31 || t === 26 || t === 27 || t === 3)
        return l;
    }
    return null;
  }
  function Ga(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l.stateNode;
    throw Error(m(33));
  }
  function Fe(l) {
    var t = l[Gf];
    return t || (t = l[Gf] = { hoistableStyles: /* @__PURE__ */ new Map(), hoistableScripts: /* @__PURE__ */ new Map() }), t;
  }
  function Hl(l) {
    l[Ya] = !0;
  }
  var Lf = /* @__PURE__ */ new Set(), Qf = {};
  function _e(l, t) {
    Ie(l, t), Ie(l + "Capture", t);
  }
  function Ie(l, t) {
    for (Qf[l] = t, l = 0; l < t.length; l++)
      Lf.add(t[l]);
  }
  var cm = RegExp(
    "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"
  ), Xf = {}, Zf = {};
  function fm(l) {
    return ei.call(Zf, l) ? !0 : ei.call(Xf, l) ? !1 : cm.test(l) ? Zf[l] = !0 : (Xf[l] = !0, !1);
  }
  function Bu(l, t, e) {
    if (fm(t))
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
  function Yu(l, t, e) {
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
  function Rt(l, t, e, a) {
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
  function mt(l) {
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
  function Vf(l) {
    var t = l.type;
    return (l = l.nodeName) && l.toLowerCase() === "input" && (t === "checkbox" || t === "radio");
  }
  function sm(l, t, e) {
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
  function oi(l) {
    if (!l._valueTracker) {
      var t = Vf(l) ? "checked" : "value";
      l._valueTracker = sm(
        l,
        t,
        "" + l[t]
      );
    }
  }
  function Kf(l) {
    if (!l) return !1;
    var t = l._valueTracker;
    if (!t) return !0;
    var e = t.getValue(), a = "";
    return l && (a = Vf(l) ? l.checked ? "true" : "false" : l.value), l = a, l !== e ? (t.setValue(l), !0) : !1;
  }
  function Gu(l) {
    if (l = l || (typeof document < "u" ? document : void 0), typeof l > "u") return null;
    try {
      return l.activeElement || l.body;
    } catch {
      return l.body;
    }
  }
  var om = /[\n"\\]/g;
  function ht(l) {
    return l.replace(
      om,
      function(t) {
        return "\\" + t.charCodeAt(0).toString(16) + " ";
      }
    );
  }
  function di(l, t, e, a, u, n, i, c) {
    l.name = "", i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" ? l.type = i : l.removeAttribute("type"), t != null ? i === "number" ? (t === 0 && l.value === "" || l.value != t) && (l.value = "" + mt(t)) : l.value !== "" + mt(t) && (l.value = "" + mt(t)) : i !== "submit" && i !== "reset" || l.removeAttribute("value"), t != null ? ri(l, i, mt(t)) : e != null ? ri(l, i, mt(e)) : a != null && l.removeAttribute("value"), u == null && n != null && (l.defaultChecked = !!n), u != null && (l.checked = u && typeof u != "function" && typeof u != "symbol"), c != null && typeof c != "function" && typeof c != "symbol" && typeof c != "boolean" ? l.name = "" + mt(c) : l.removeAttribute("name");
  }
  function Jf(l, t, e, a, u, n, i, c) {
    if (n != null && typeof n != "function" && typeof n != "symbol" && typeof n != "boolean" && (l.type = n), t != null || e != null) {
      if (!(n !== "submit" && n !== "reset" || t != null)) {
        oi(l);
        return;
      }
      e = e != null ? "" + mt(e) : "", t = t != null ? "" + mt(t) : e, c || t === l.value || (l.value = t), l.defaultValue = t;
    }
    a = a ?? u, a = typeof a != "function" && typeof a != "symbol" && !!a, l.checked = c ? l.checked : !!a, l.defaultChecked = !!a, i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" && (l.name = i), oi(l);
  }
  function ri(l, t, e) {
    t === "number" && Gu(l.ownerDocument) === l || l.defaultValue === "" + e || (l.defaultValue = "" + e);
  }
  function Pe(l, t, e, a) {
    if (l = l.options, t) {
      t = {};
      for (var u = 0; u < e.length; u++)
        t["$" + e[u]] = !0;
      for (e = 0; e < l.length; e++)
        u = t.hasOwnProperty("$" + l[e].value), l[e].selected !== u && (l[e].selected = u), u && a && (l[e].defaultSelected = !0);
    } else {
      for (e = "" + mt(e), t = null, u = 0; u < l.length; u++) {
        if (l[u].value === e) {
          l[u].selected = !0, a && (l[u].defaultSelected = !0);
          return;
        }
        t !== null || l[u].disabled || (t = l[u]);
      }
      t !== null && (t.selected = !0);
    }
  }
  function wf(l, t, e) {
    if (t != null && (t = "" + mt(t), t !== l.value && (l.value = t), e == null)) {
      l.defaultValue !== t && (l.defaultValue = t);
      return;
    }
    l.defaultValue = e != null ? "" + mt(e) : "";
  }
  function $f(l, t, e, a) {
    if (t == null) {
      if (a != null) {
        if (e != null) throw Error(m(92));
        if (Tt(a)) {
          if (1 < a.length) throw Error(m(93));
          a = a[0];
        }
        e = a;
      }
      e == null && (e = ""), t = e;
    }
    e = mt(t), l.defaultValue = e, a = l.textContent, a === e && a !== "" && a !== null && (l.value = a), oi(l);
  }
  function la(l, t) {
    if (t) {
      var e = l.firstChild;
      if (e && e === l.lastChild && e.nodeType === 3) {
        e.nodeValue = t;
        return;
      }
    }
    l.textContent = t;
  }
  var dm = new Set(
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
      " "
    )
  );
  function Wf(l, t, e) {
    var a = t.indexOf("--") === 0;
    e == null || typeof e == "boolean" || e === "" ? a ? l.setProperty(t, "") : t === "float" ? l.cssFloat = "" : l[t] = "" : a ? l.setProperty(t, e) : typeof e != "number" || e === 0 || dm.has(t) ? t === "float" ? l.cssFloat = e : l[t] = ("" + e).trim() : l[t] = e + "px";
  }
  function kf(l, t, e) {
    if (t != null && typeof t != "object")
      throw Error(m(62));
    if (l = l.style, e != null) {
      for (var a in e)
        !e.hasOwnProperty(a) || t != null && t.hasOwnProperty(a) || (a.indexOf("--") === 0 ? l.setProperty(a, "") : a === "float" ? l.cssFloat = "" : l[a] = "");
      for (var u in t)
        a = t[u], t.hasOwnProperty(u) && e[u] !== a && Wf(l, u, a);
    } else
      for (var n in t)
        t.hasOwnProperty(n) && Wf(l, n, t[n]);
  }
  function mi(l) {
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
  var rm = /* @__PURE__ */ new Map([
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
  ]), mm = /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function Lu(l) {
    return mm.test("" + l) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : l;
  }
  function Ct() {
  }
  var hi = null;
  function yi(l) {
    return l = l.target || l.srcElement || window, l.correspondingUseElement && (l = l.correspondingUseElement), l.nodeType === 3 ? l.parentNode : l;
  }
  var ta = null, ea = null;
  function Ff(l) {
    var t = ke(l);
    if (t && (l = t.stateNode)) {
      var e = l[$l] || null;
      l: switch (l = t.stateNode, t.type) {
        case "input":
          if (di(
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
              'input[name="' + ht(
                "" + t
              ) + '"][type="radio"]'
            ), t = 0; t < e.length; t++) {
              var a = e[t];
              if (a !== l && a.form === l.form) {
                var u = a[$l] || null;
                if (!u) throw Error(m(90));
                di(
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
              a = e[t], a.form === l.form && Kf(a);
          }
          break l;
        case "textarea":
          wf(l, e.value, e.defaultValue);
          break l;
        case "select":
          t = e.value, t != null && Pe(l, !!e.multiple, t, !1);
      }
    }
  }
  var vi = !1;
  function If(l, t, e) {
    if (vi) return l(t, e);
    vi = !0;
    try {
      var a = l(t);
      return a;
    } finally {
      if (vi = !1, (ta !== null || ea !== null) && (On(), ta && (t = ta, l = ea, ea = ta = null, Ff(t), l)))
        for (t = 0; t < l.length; t++) Ff(l[t]);
    }
  }
  function La(l, t) {
    var e = l.stateNode;
    if (e === null) return null;
    var a = e[$l] || null;
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
        m(231, t, typeof e)
      );
    return e;
  }
  var Ht = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), gi = !1;
  if (Ht)
    try {
      var Qa = {};
      Object.defineProperty(Qa, "passive", {
        get: function() {
          gi = !0;
        }
      }), window.addEventListener("test", Qa, Qa), window.removeEventListener("test", Qa, Qa);
    } catch {
      gi = !1;
    }
  var ee = null, bi = null, Qu = null;
  function Pf() {
    if (Qu) return Qu;
    var l, t = bi, e = t.length, a, u = "value" in ee ? ee.value : ee.textContent, n = u.length;
    for (l = 0; l < e && t[l] === u[l]; l++) ;
    var i = e - l;
    for (a = 1; a <= i && t[e - a] === u[n - a]; a++) ;
    return Qu = u.slice(l, 1 < a ? 1 - a : void 0);
  }
  function Xu(l) {
    var t = l.keyCode;
    return "charCode" in l ? (l = l.charCode, l === 0 && t === 13 && (l = 13)) : l = t, l === 10 && (l = 13), 32 <= l || l === 13 ? l : 0;
  }
  function Zu() {
    return !0;
  }
  function ls() {
    return !1;
  }
  function Wl(l) {
    function t(e, a, u, n, i) {
      this._reactName = e, this._targetInst = u, this.type = a, this.nativeEvent = n, this.target = i, this.currentTarget = null;
      for (var c in l)
        l.hasOwnProperty(c) && (e = l[c], this[c] = e ? e(n) : n[c]);
      return this.isDefaultPrevented = (n.defaultPrevented != null ? n.defaultPrevented : n.returnValue === !1) ? Zu : ls, this.isPropagationStopped = ls, this;
    }
    return T(t.prototype, {
      preventDefault: function() {
        this.defaultPrevented = !0;
        var e = this.nativeEvent;
        e && (e.preventDefault ? e.preventDefault() : typeof e.returnValue != "unknown" && (e.returnValue = !1), this.isDefaultPrevented = Zu);
      },
      stopPropagation: function() {
        var e = this.nativeEvent;
        e && (e.stopPropagation ? e.stopPropagation() : typeof e.cancelBubble != "unknown" && (e.cancelBubble = !0), this.isPropagationStopped = Zu);
      },
      persist: function() {
      },
      isPersistent: Zu
    }), t;
  }
  var Me = {
    eventPhase: 0,
    bubbles: 0,
    cancelable: 0,
    timeStamp: function(l) {
      return l.timeStamp || Date.now();
    },
    defaultPrevented: 0,
    isTrusted: 0
  }, Vu = Wl(Me), Xa = T({}, Me, { view: 0, detail: 0 }), hm = Wl(Xa), Si, pi, Za, Ku = T({}, Xa, {
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
    getModifierState: zi,
    button: 0,
    buttons: 0,
    relatedTarget: function(l) {
      return l.relatedTarget === void 0 ? l.fromElement === l.srcElement ? l.toElement : l.fromElement : l.relatedTarget;
    },
    movementX: function(l) {
      return "movementX" in l ? l.movementX : (l !== Za && (Za && l.type === "mousemove" ? (Si = l.screenX - Za.screenX, pi = l.screenY - Za.screenY) : pi = Si = 0, Za = l), Si);
    },
    movementY: function(l) {
      return "movementY" in l ? l.movementY : pi;
    }
  }), ts = Wl(Ku), ym = T({}, Ku, { dataTransfer: 0 }), vm = Wl(ym), gm = T({}, Xa, { relatedTarget: 0 }), Ai = Wl(gm), bm = T({}, Me, {
    animationName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Sm = Wl(bm), pm = T({}, Me, {
    clipboardData: function(l) {
      return "clipboardData" in l ? l.clipboardData : window.clipboardData;
    }
  }), Am = Wl(pm), zm = T({}, Me, { data: 0 }), es = Wl(zm), Tm = {
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
  }, jm = {
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
  }, Em = {
    Alt: "altKey",
    Control: "ctrlKey",
    Meta: "metaKey",
    Shift: "shiftKey"
  };
  function xm(l) {
    var t = this.nativeEvent;
    return t.getModifierState ? t.getModifierState(l) : (l = Em[l]) ? !!t[l] : !1;
  }
  function zi() {
    return xm;
  }
  var Nm = T({}, Xa, {
    key: function(l) {
      if (l.key) {
        var t = Tm[l.key] || l.key;
        if (t !== "Unidentified") return t;
      }
      return l.type === "keypress" ? (l = Xu(l), l === 13 ? "Enter" : String.fromCharCode(l)) : l.type === "keydown" || l.type === "keyup" ? jm[l.keyCode] || "Unidentified" : "";
    },
    code: 0,
    location: 0,
    ctrlKey: 0,
    shiftKey: 0,
    altKey: 0,
    metaKey: 0,
    repeat: 0,
    locale: 0,
    getModifierState: zi,
    charCode: function(l) {
      return l.type === "keypress" ? Xu(l) : 0;
    },
    keyCode: function(l) {
      return l.type === "keydown" || l.type === "keyup" ? l.keyCode : 0;
    },
    which: function(l) {
      return l.type === "keypress" ? Xu(l) : l.type === "keydown" || l.type === "keyup" ? l.keyCode : 0;
    }
  }), Om = Wl(Nm), _m = T({}, Ku, {
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
  }), as = Wl(_m), Mm = T({}, Xa, {
    touches: 0,
    targetTouches: 0,
    changedTouches: 0,
    altKey: 0,
    metaKey: 0,
    ctrlKey: 0,
    shiftKey: 0,
    getModifierState: zi
  }), Dm = Wl(Mm), Um = T({}, Me, {
    propertyName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Rm = Wl(Um), Cm = T({}, Ku, {
    deltaX: function(l) {
      return "deltaX" in l ? l.deltaX : "wheelDeltaX" in l ? -l.wheelDeltaX : 0;
    },
    deltaY: function(l) {
      return "deltaY" in l ? l.deltaY : "wheelDeltaY" in l ? -l.wheelDeltaY : "wheelDelta" in l ? -l.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), Hm = Wl(Cm), qm = T({}, Me, {
    newState: 0,
    oldState: 0
  }), Bm = Wl(qm), Ym = [9, 13, 27, 32], Ti = Ht && "CompositionEvent" in window, Va = null;
  Ht && "documentMode" in document && (Va = document.documentMode);
  var Gm = Ht && "TextEvent" in window && !Va, us = Ht && (!Ti || Va && 8 < Va && 11 >= Va), ns = " ", is = !1;
  function cs(l, t) {
    switch (l) {
      case "keyup":
        return Ym.indexOf(t.keyCode) !== -1;
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
  function fs(l) {
    return l = l.detail, typeof l == "object" && "data" in l ? l.data : null;
  }
  var aa = !1;
  function Lm(l, t) {
    switch (l) {
      case "compositionend":
        return fs(t);
      case "keypress":
        return t.which !== 32 ? null : (is = !0, ns);
      case "textInput":
        return l = t.data, l === ns && is ? null : l;
      default:
        return null;
    }
  }
  function Qm(l, t) {
    if (aa)
      return l === "compositionend" || !Ti && cs(l, t) ? (l = Pf(), Qu = bi = ee = null, aa = !1, l) : null;
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
        return us && t.locale !== "ko" ? null : t.data;
      default:
        return null;
    }
  }
  var Xm = {
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
  function ss(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t === "input" ? !!Xm[l.type] : t === "textarea";
  }
  function os(l, t, e, a) {
    ta ? ea ? ea.push(a) : ea = [a] : ta = a, t = Hn(t, "onChange"), 0 < t.length && (e = new Vu(
      "onChange",
      "change",
      null,
      e,
      a
    ), l.push({ event: e, listeners: t }));
  }
  var Ka = null, Ja = null;
  function Zm(l) {
    wd(l, 0);
  }
  function Ju(l) {
    var t = Ga(l);
    if (Kf(t)) return l;
  }
  function ds(l, t) {
    if (l === "change") return t;
  }
  var rs = !1;
  if (Ht) {
    var ji;
    if (Ht) {
      var Ei = "oninput" in document;
      if (!Ei) {
        var ms = document.createElement("div");
        ms.setAttribute("oninput", "return;"), Ei = typeof ms.oninput == "function";
      }
      ji = Ei;
    } else ji = !1;
    rs = ji && (!document.documentMode || 9 < document.documentMode);
  }
  function hs() {
    Ka && (Ka.detachEvent("onpropertychange", ys), Ja = Ka = null);
  }
  function ys(l) {
    if (l.propertyName === "value" && Ju(Ja)) {
      var t = [];
      os(
        t,
        Ja,
        l,
        yi(l)
      ), If(Zm, t);
    }
  }
  function Vm(l, t, e) {
    l === "focusin" ? (hs(), Ka = t, Ja = e, Ka.attachEvent("onpropertychange", ys)) : l === "focusout" && hs();
  }
  function Km(l) {
    if (l === "selectionchange" || l === "keyup" || l === "keydown")
      return Ju(Ja);
  }
  function Jm(l, t) {
    if (l === "click") return Ju(t);
  }
  function wm(l, t) {
    if (l === "input" || l === "change")
      return Ju(t);
  }
  function $m(l, t) {
    return l === t && (l !== 0 || 1 / l === 1 / t) || l !== l && t !== t;
  }
  var ut = typeof Object.is == "function" ? Object.is : $m;
  function wa(l, t) {
    if (ut(l, t)) return !0;
    if (typeof l != "object" || l === null || typeof t != "object" || t === null)
      return !1;
    var e = Object.keys(l), a = Object.keys(t);
    if (e.length !== a.length) return !1;
    for (a = 0; a < e.length; a++) {
      var u = e[a];
      if (!ei.call(t, u) || !ut(l[u], t[u]))
        return !1;
    }
    return !0;
  }
  function vs(l) {
    for (; l && l.firstChild; ) l = l.firstChild;
    return l;
  }
  function gs(l, t) {
    var e = vs(l);
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
      e = vs(e);
    }
  }
  function bs(l, t) {
    return l && t ? l === t ? !0 : l && l.nodeType === 3 ? !1 : t && t.nodeType === 3 ? bs(l, t.parentNode) : "contains" in l ? l.contains(t) : l.compareDocumentPosition ? !!(l.compareDocumentPosition(t) & 16) : !1 : !1;
  }
  function Ss(l) {
    l = l != null && l.ownerDocument != null && l.ownerDocument.defaultView != null ? l.ownerDocument.defaultView : window;
    for (var t = Gu(l.document); t instanceof l.HTMLIFrameElement; ) {
      try {
        var e = typeof t.contentWindow.location.href == "string";
      } catch {
        e = !1;
      }
      if (e) l = t.contentWindow;
      else break;
      t = Gu(l.document);
    }
    return t;
  }
  function xi(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t && (t === "input" && (l.type === "text" || l.type === "search" || l.type === "tel" || l.type === "url" || l.type === "password") || t === "textarea" || l.contentEditable === "true");
  }
  var Wm = Ht && "documentMode" in document && 11 >= document.documentMode, ua = null, Ni = null, $a = null, Oi = !1;
  function ps(l, t, e) {
    var a = e.window === e ? e.document : e.nodeType === 9 ? e : e.ownerDocument;
    Oi || ua == null || ua !== Gu(a) || (a = ua, "selectionStart" in a && xi(a) ? a = { start: a.selectionStart, end: a.selectionEnd } : (a = (a.ownerDocument && a.ownerDocument.defaultView || window).getSelection(), a = {
      anchorNode: a.anchorNode,
      anchorOffset: a.anchorOffset,
      focusNode: a.focusNode,
      focusOffset: a.focusOffset
    }), $a && wa($a, a) || ($a = a, a = Hn(Ni, "onSelect"), 0 < a.length && (t = new Vu(
      "onSelect",
      "select",
      null,
      t,
      e
    ), l.push({ event: t, listeners: a }), t.target = ua)));
  }
  function De(l, t) {
    var e = {};
    return e[l.toLowerCase()] = t.toLowerCase(), e["Webkit" + l] = "webkit" + t, e["Moz" + l] = "moz" + t, e;
  }
  var na = {
    animationend: De("Animation", "AnimationEnd"),
    animationiteration: De("Animation", "AnimationIteration"),
    animationstart: De("Animation", "AnimationStart"),
    transitionrun: De("Transition", "TransitionRun"),
    transitionstart: De("Transition", "TransitionStart"),
    transitioncancel: De("Transition", "TransitionCancel"),
    transitionend: De("Transition", "TransitionEnd")
  }, _i = {}, As = {};
  Ht && (As = document.createElement("div").style, "AnimationEvent" in window || (delete na.animationend.animation, delete na.animationiteration.animation, delete na.animationstart.animation), "TransitionEvent" in window || delete na.transitionend.transition);
  function Ue(l) {
    if (_i[l]) return _i[l];
    if (!na[l]) return l;
    var t = na[l], e;
    for (e in t)
      if (t.hasOwnProperty(e) && e in As)
        return _i[l] = t[e];
    return l;
  }
  var zs = Ue("animationend"), Ts = Ue("animationiteration"), js = Ue("animationstart"), km = Ue("transitionrun"), Fm = Ue("transitionstart"), Im = Ue("transitioncancel"), Es = Ue("transitionend"), xs = /* @__PURE__ */ new Map(), Mi = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
    " "
  );
  Mi.push("scrollEnd");
  function jt(l, t) {
    xs.set(l, t), _e(t, [l]);
  }
  var wu = typeof reportError == "function" ? reportError : function(l) {
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
  }, yt = [], ia = 0, Di = 0;
  function $u() {
    for (var l = ia, t = Di = ia = 0; t < l; ) {
      var e = yt[t];
      yt[t++] = null;
      var a = yt[t];
      yt[t++] = null;
      var u = yt[t];
      yt[t++] = null;
      var n = yt[t];
      if (yt[t++] = null, a !== null && u !== null) {
        var i = a.pending;
        i === null ? u.next = u : (u.next = i.next, i.next = u), a.pending = u;
      }
      n !== 0 && Ns(e, u, n);
    }
  }
  function Wu(l, t, e, a) {
    yt[ia++] = l, yt[ia++] = t, yt[ia++] = e, yt[ia++] = a, Di |= a, l.lanes |= a, l = l.alternate, l !== null && (l.lanes |= a);
  }
  function Ui(l, t, e, a) {
    return Wu(l, t, e, a), ku(l);
  }
  function Re(l, t) {
    return Wu(l, null, null, t), ku(l);
  }
  function Ns(l, t, e) {
    l.lanes |= e;
    var a = l.alternate;
    a !== null && (a.lanes |= e);
    for (var u = !1, n = l.return; n !== null; )
      n.childLanes |= e, a = n.alternate, a !== null && (a.childLanes |= e), n.tag === 22 && (l = n.stateNode, l === null || l._visibility & 1 || (u = !0)), l = n, n = n.return;
    return l.tag === 3 ? (n = l.stateNode, u && t !== null && (u = 31 - at(e), l = n.hiddenUpdates, a = l[u], a === null ? l[u] = [t] : a.push(t), t.lane = e | 536870912), n) : null;
  }
  function ku(l) {
    if (50 < vu)
      throw vu = 0, Qc = null, Error(m(185));
    for (var t = l.return; t !== null; )
      l = t, t = l.return;
    return l.tag === 3 ? l.stateNode : null;
  }
  var ca = {};
  function Pm(l, t, e, a) {
    this.tag = l, this.key = e, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = a, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function nt(l, t, e, a) {
    return new Pm(l, t, e, a);
  }
  function Ri(l) {
    return l = l.prototype, !(!l || !l.isReactComponent);
  }
  function qt(l, t) {
    var e = l.alternate;
    return e === null ? (e = nt(
      l.tag,
      t,
      l.key,
      l.mode
    ), e.elementType = l.elementType, e.type = l.type, e.stateNode = l.stateNode, e.alternate = l, l.alternate = e) : (e.pendingProps = t, e.type = l.type, e.flags = 0, e.subtreeFlags = 0, e.deletions = null), e.flags = l.flags & 65011712, e.childLanes = l.childLanes, e.lanes = l.lanes, e.child = l.child, e.memoizedProps = l.memoizedProps, e.memoizedState = l.memoizedState, e.updateQueue = l.updateQueue, t = l.dependencies, e.dependencies = t === null ? null : { lanes: t.lanes, firstContext: t.firstContext }, e.sibling = l.sibling, e.index = l.index, e.ref = l.ref, e.refCleanup = l.refCleanup, e;
  }
  function Os(l, t) {
    l.flags &= 65011714;
    var e = l.alternate;
    return e === null ? (l.childLanes = 0, l.lanes = t, l.child = null, l.subtreeFlags = 0, l.memoizedProps = null, l.memoizedState = null, l.updateQueue = null, l.dependencies = null, l.stateNode = null) : (l.childLanes = e.childLanes, l.lanes = e.lanes, l.child = e.child, l.subtreeFlags = 0, l.deletions = null, l.memoizedProps = e.memoizedProps, l.memoizedState = e.memoizedState, l.updateQueue = e.updateQueue, l.type = e.type, t = e.dependencies, l.dependencies = t === null ? null : {
      lanes: t.lanes,
      firstContext: t.firstContext
    }), l;
  }
  function Fu(l, t, e, a, u, n) {
    var i = 0;
    if (a = l, typeof l == "function") Ri(l) && (i = 1);
    else if (typeof l == "string")
      i = uy(
        l,
        e,
        B.current
      ) ? 26 : l === "html" || l === "head" || l === "body" ? 27 : 5;
    else
      l: switch (l) {
        case Jl:
          return l = nt(31, e, t, u), l.elementType = Jl, l.lanes = n, l;
        case xl:
          return Ce(e.children, u, n, t);
        case Nl:
          i = 8, u |= 24;
          break;
        case cl:
          return l = nt(12, e, t, u | 2), l.elementType = cl, l.lanes = n, l;
        case rt:
          return l = nt(13, e, t, u), l.elementType = rt, l.lanes = n, l;
        case X:
          return l = nt(19, e, t, u), l.elementType = X, l.lanes = n, l;
        default:
          if (typeof l == "object" && l !== null)
            switch (l.$$typeof) {
              case Rl:
                i = 10;
                break l;
              case tl:
                i = 9;
                break l;
              case Kl:
                i = 11;
                break l;
              case w:
                i = 14;
                break l;
              case Cl:
                i = 16, a = null;
                break l;
            }
          i = 29, e = Error(
            m(130, l === null ? "null" : typeof l, "")
          ), a = null;
      }
    return t = nt(i, e, t, u), t.elementType = l, t.type = a, t.lanes = n, t;
  }
  function Ce(l, t, e, a) {
    return l = nt(7, l, a, t), l.lanes = e, l;
  }
  function Ci(l, t, e) {
    return l = nt(6, l, null, t), l.lanes = e, l;
  }
  function _s(l) {
    var t = nt(18, null, null, 0);
    return t.stateNode = l, t;
  }
  function Hi(l, t, e) {
    return t = nt(
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
  var Ms = /* @__PURE__ */ new WeakMap();
  function vt(l, t) {
    if (typeof l == "object" && l !== null) {
      var e = Ms.get(l);
      return e !== void 0 ? e : (t = {
        value: l,
        source: t,
        stack: _f(t)
      }, Ms.set(l, t), t);
    }
    return {
      value: l,
      source: t,
      stack: _f(t)
    };
  }
  var fa = [], sa = 0, Iu = null, Wa = 0, gt = [], bt = 0, ae = null, Ot = 1, _t = "";
  function Bt(l, t) {
    fa[sa++] = Wa, fa[sa++] = Iu, Iu = l, Wa = t;
  }
  function Ds(l, t, e) {
    gt[bt++] = Ot, gt[bt++] = _t, gt[bt++] = ae, ae = l;
    var a = Ot;
    l = _t;
    var u = 32 - at(a) - 1;
    a &= ~(1 << u), e += 1;
    var n = 32 - at(t) + u;
    if (30 < n) {
      var i = u - u % 5;
      n = (a & (1 << i) - 1).toString(32), a >>= i, u -= i, Ot = 1 << 32 - at(t) + u | e << u | a, _t = n + l;
    } else
      Ot = 1 << n | e << u | a, _t = l;
  }
  function qi(l) {
    l.return !== null && (Bt(l, 1), Ds(l, 1, 0));
  }
  function Bi(l) {
    for (; l === Iu; )
      Iu = fa[--sa], fa[sa] = null, Wa = fa[--sa], fa[sa] = null;
    for (; l === ae; )
      ae = gt[--bt], gt[bt] = null, _t = gt[--bt], gt[bt] = null, Ot = gt[--bt], gt[bt] = null;
  }
  function Us(l, t) {
    gt[bt++] = Ot, gt[bt++] = _t, gt[bt++] = ae, Ot = t.id, _t = t.overflow, ae = l;
  }
  var Yl = null, vl = null, el = !1, ue = null, St = !1, Yi = Error(m(519));
  function ne(l) {
    var t = Error(
      m(
        418,
        1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML",
        ""
      )
    );
    throw ka(vt(t, l)), Yi;
  }
  function Rs(l) {
    var t = l.stateNode, e = l.type, a = l.memoizedProps;
    switch (t[Bl] = l, t[$l] = a, e) {
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
        I("invalid", t), Jf(
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
        I("invalid", t), $f(t, a.value, a.defaultValue, a.children);
    }
    e = a.children, typeof e != "string" && typeof e != "number" && typeof e != "bigint" || t.textContent === "" + e || a.suppressHydrationWarning === !0 || Fd(t.textContent, e) ? (a.popover != null && (I("beforetoggle", t), I("toggle", t)), a.onScroll != null && I("scroll", t), a.onScrollEnd != null && I("scrollend", t), a.onClick != null && (t.onclick = Ct), t = !0) : t = !1, t || ne(l, !0);
  }
  function Cs(l) {
    for (Yl = l.return; Yl; )
      switch (Yl.tag) {
        case 5:
        case 31:
        case 13:
          St = !1;
          return;
        case 27:
        case 3:
          St = !0;
          return;
        default:
          Yl = Yl.return;
      }
  }
  function oa(l) {
    if (l !== Yl) return !1;
    if (!el) return Cs(l), el = !0, !1;
    var t = l.tag, e;
    if ((e = t !== 3 && t !== 27) && ((e = t === 5) && (e = l.type, e = !(e !== "form" && e !== "button") || ef(l.type, l.memoizedProps)), e = !e), e && vl && ne(l), Cs(l), t === 13) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(m(317));
      vl = ir(l);
    } else if (t === 31) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(m(317));
      vl = ir(l);
    } else
      t === 27 ? (t = vl, Se(l.type) ? (l = ff, ff = null, vl = l) : vl = t) : vl = Yl ? At(l.stateNode.nextSibling) : null;
    return !0;
  }
  function He() {
    vl = Yl = null, el = !1;
  }
  function Gi() {
    var l = ue;
    return l !== null && (Pl === null ? Pl = l : Pl.push.apply(
      Pl,
      l
    ), ue = null), l;
  }
  function ka(l) {
    ue === null ? ue = [l] : ue.push(l);
  }
  var Li = r(null), qe = null, Yt = null;
  function ie(l, t, e) {
    R(Li, t._currentValue), t._currentValue = e;
  }
  function Gt(l) {
    l._currentValue = Li.current, x(Li);
  }
  function Qi(l, t, e) {
    for (; l !== null; ) {
      var a = l.alternate;
      if ((l.childLanes & t) !== t ? (l.childLanes |= t, a !== null && (a.childLanes |= t)) : a !== null && (a.childLanes & t) !== t && (a.childLanes |= t), l === e) break;
      l = l.return;
    }
  }
  function Xi(l, t, e, a) {
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
              n.lanes |= e, c = n.alternate, c !== null && (c.lanes |= e), Qi(
                n.return,
                e,
                l
              ), a || (i = null);
              break l;
            }
          n = c.next;
        }
      } else if (u.tag === 18) {
        if (i = u.return, i === null) throw Error(m(341));
        i.lanes |= e, n = i.alternate, n !== null && (n.lanes |= e), Qi(i, e, l), i = null;
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
  function da(l, t, e, a) {
    l = null;
    for (var u = t, n = !1; u !== null; ) {
      if (!n) {
        if ((u.flags & 524288) !== 0) n = !0;
        else if ((u.flags & 262144) !== 0) break;
      }
      if (u.tag === 10) {
        var i = u.alternate;
        if (i === null) throw Error(m(387));
        if (i = i.memoizedProps, i !== null) {
          var c = u.type;
          ut(u.pendingProps.value, i.value) || (l !== null ? l.push(c) : l = [c]);
        }
      } else if (u === il.current) {
        if (i = u.alternate, i === null) throw Error(m(387));
        i.memoizedState.memoizedState !== u.memoizedState.memoizedState && (l !== null ? l.push(Tu) : l = [Tu]);
      }
      u = u.return;
    }
    l !== null && Xi(
      t,
      l,
      e,
      a
    ), t.flags |= 262144;
  }
  function Pu(l) {
    for (l = l.firstContext; l !== null; ) {
      if (!ut(
        l.context._currentValue,
        l.memoizedValue
      ))
        return !0;
      l = l.next;
    }
    return !1;
  }
  function Be(l) {
    qe = l, Yt = null, l = l.dependencies, l !== null && (l.firstContext = null);
  }
  function Gl(l) {
    return Hs(qe, l);
  }
  function ln(l, t) {
    return qe === null && Be(l), Hs(l, t);
  }
  function Hs(l, t) {
    var e = t._currentValue;
    if (t = { context: t, memoizedValue: e, next: null }, Yt === null) {
      if (l === null) throw Error(m(308));
      Yt = t, l.dependencies = { lanes: 0, firstContext: t }, l.flags |= 524288;
    } else Yt = Yt.next = t;
    return e;
  }
  var lh = typeof AbortController < "u" ? AbortController : function() {
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
  }, th = o.unstable_scheduleCallback, eh = o.unstable_NormalPriority, Ol = {
    $$typeof: Rl,
    Consumer: null,
    Provider: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0
  };
  function Zi() {
    return {
      controller: new lh(),
      data: /* @__PURE__ */ new Map(),
      refCount: 0
    };
  }
  function Fa(l) {
    l.refCount--, l.refCount === 0 && th(eh, function() {
      l.controller.abort();
    });
  }
  var Ia = null, Vi = 0, ra = 0, ma = null;
  function ah(l, t) {
    if (Ia === null) {
      var e = Ia = [];
      Vi = 0, ra = wc(), ma = {
        status: "pending",
        value: void 0,
        then: function(a) {
          e.push(a);
        }
      };
    }
    return Vi++, t.then(qs, qs), t;
  }
  function qs() {
    if (--Vi === 0 && Ia !== null) {
      ma !== null && (ma.status = "fulfilled");
      var l = Ia;
      Ia = null, ra = 0, ma = null;
      for (var t = 0; t < l.length; t++) (0, l[t])();
    }
  }
  function uh(l, t) {
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
  var Bs = A.S;
  A.S = function(l, t) {
    Ad = tt(), typeof t == "object" && t !== null && typeof t.then == "function" && ah(l, t), Bs !== null && Bs(l, t);
  };
  var Ye = r(null);
  function Ki() {
    var l = Ye.current;
    return l !== null ? l : yl.pooledCache;
  }
  function tn(l, t) {
    t === null ? R(Ye, Ye.current) : R(Ye, t.pool);
  }
  function Ys() {
    var l = Ki();
    return l === null ? null : { parent: Ol._currentValue, pool: l };
  }
  var ha = Error(m(460)), Ji = Error(m(474)), en = Error(m(542)), an = { then: function() {
  } };
  function Gs(l) {
    return l = l.status, l === "fulfilled" || l === "rejected";
  }
  function Ls(l, t, e) {
    switch (e = l[e], e === void 0 ? l.push(t) : e !== t && (t.then(Ct, Ct), t = e), t.status) {
      case "fulfilled":
        return t.value;
      case "rejected":
        throw l = t.reason, Xs(l), l;
      default:
        if (typeof t.status == "string") t.then(Ct, Ct);
        else {
          if (l = yl, l !== null && 100 < l.shellSuspendCounter)
            throw Error(m(482));
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
            throw l = t.reason, Xs(l), l;
        }
        throw Le = t, ha;
    }
  }
  function Ge(l) {
    try {
      var t = l._init;
      return t(l._payload);
    } catch (e) {
      throw e !== null && typeof e == "object" && typeof e.then == "function" ? (Le = e, ha) : e;
    }
  }
  var Le = null;
  function Qs() {
    if (Le === null) throw Error(m(459));
    var l = Le;
    return Le = null, l;
  }
  function Xs(l) {
    if (l === ha || l === en)
      throw Error(m(483));
  }
  var ya = null, Pa = 0;
  function un(l) {
    var t = Pa;
    return Pa += 1, ya === null && (ya = []), Ls(ya, l, t);
  }
  function lu(l, t) {
    t = t.props.ref, l.ref = t !== void 0 ? t : null;
  }
  function nn(l, t) {
    throw t.$$typeof === q ? Error(m(525)) : (l = Object.prototype.toString.call(t), Error(
      m(
        31,
        l === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : l
      )
    ));
  }
  function Zs(l) {
    function t(h, d) {
      if (l) {
        var y = h.deletions;
        y === null ? (h.deletions = [d], h.flags |= 16) : y.push(d);
      }
    }
    function e(h, d) {
      if (!l) return null;
      for (; d !== null; )
        t(h, d), d = d.sibling;
      return null;
    }
    function a(h) {
      for (var d = /* @__PURE__ */ new Map(); h !== null; )
        h.key !== null ? d.set(h.key, h) : d.set(h.index, h), h = h.sibling;
      return d;
    }
    function u(h, d) {
      return h = qt(h, d), h.index = 0, h.sibling = null, h;
    }
    function n(h, d, y) {
      return h.index = y, l ? (y = h.alternate, y !== null ? (y = y.index, y < d ? (h.flags |= 67108866, d) : y) : (h.flags |= 67108866, d)) : (h.flags |= 1048576, d);
    }
    function i(h) {
      return l && h.alternate === null && (h.flags |= 67108866), h;
    }
    function c(h, d, y, z) {
      return d === null || d.tag !== 6 ? (d = Ci(y, h.mode, z), d.return = h, d) : (d = u(d, y), d.return = h, d);
    }
    function s(h, d, y, z) {
      var G = y.type;
      return G === xl ? p(
        h,
        d,
        y.props.children,
        z,
        y.key
      ) : d !== null && (d.elementType === G || typeof G == "object" && G !== null && G.$$typeof === Cl && Ge(G) === d.type) ? (d = u(d, y.props), lu(d, y), d.return = h, d) : (d = Fu(
        y.type,
        y.key,
        y.props,
        null,
        h.mode,
        z
      ), lu(d, y), d.return = h, d);
    }
    function v(h, d, y, z) {
      return d === null || d.tag !== 4 || d.stateNode.containerInfo !== y.containerInfo || d.stateNode.implementation !== y.implementation ? (d = Hi(y, h.mode, z), d.return = h, d) : (d = u(d, y.children || []), d.return = h, d);
    }
    function p(h, d, y, z, G) {
      return d === null || d.tag !== 7 ? (d = Ce(
        y,
        h.mode,
        z,
        G
      ), d.return = h, d) : (d = u(d, y), d.return = h, d);
    }
    function j(h, d, y) {
      if (typeof d == "string" && d !== "" || typeof d == "number" || typeof d == "bigint")
        return d = Ci(
          "" + d,
          h.mode,
          y
        ), d.return = h, d;
      if (typeof d == "object" && d !== null) {
        switch (d.$$typeof) {
          case N:
            return y = Fu(
              d.type,
              d.key,
              d.props,
              null,
              h.mode,
              y
            ), lu(y, d), y.return = h, y;
          case El:
            return d = Hi(
              d,
              h.mode,
              y
            ), d.return = h, d;
          case Cl:
            return d = Ge(d), j(h, d, y);
        }
        if (Tt(d) || wl(d))
          return d = Ce(
            d,
            h.mode,
            y,
            null
          ), d.return = h, d;
        if (typeof d.then == "function")
          return j(h, un(d), y);
        if (d.$$typeof === Rl)
          return j(
            h,
            ln(h, d),
            y
          );
        nn(h, d);
      }
      return null;
    }
    function g(h, d, y, z) {
      var G = d !== null ? d.key : null;
      if (typeof y == "string" && y !== "" || typeof y == "number" || typeof y == "bigint")
        return G !== null ? null : c(h, d, "" + y, z);
      if (typeof y == "object" && y !== null) {
        switch (y.$$typeof) {
          case N:
            return y.key === G ? s(h, d, y, z) : null;
          case El:
            return y.key === G ? v(h, d, y, z) : null;
          case Cl:
            return y = Ge(y), g(h, d, y, z);
        }
        if (Tt(y) || wl(y))
          return G !== null ? null : p(h, d, y, z, null);
        if (typeof y.then == "function")
          return g(
            h,
            d,
            un(y),
            z
          );
        if (y.$$typeof === Rl)
          return g(
            h,
            d,
            ln(h, y),
            z
          );
        nn(h, y);
      }
      return null;
    }
    function b(h, d, y, z, G) {
      if (typeof z == "string" && z !== "" || typeof z == "number" || typeof z == "bigint")
        return h = h.get(y) || null, c(d, h, "" + z, G);
      if (typeof z == "object" && z !== null) {
        switch (z.$$typeof) {
          case N:
            return h = h.get(
              z.key === null ? y : z.key
            ) || null, s(d, h, z, G);
          case El:
            return h = h.get(
              z.key === null ? y : z.key
            ) || null, v(d, h, z, G);
          case Cl:
            return z = Ge(z), b(
              h,
              d,
              y,
              z,
              G
            );
        }
        if (Tt(z) || wl(z))
          return h = h.get(y) || null, p(d, h, z, G, null);
        if (typeof z.then == "function")
          return b(
            h,
            d,
            y,
            un(z),
            G
          );
        if (z.$$typeof === Rl)
          return b(
            h,
            d,
            y,
            ln(d, z),
            G
          );
        nn(d, z);
      }
      return null;
    }
    function H(h, d, y, z) {
      for (var G = null, al = null, Y = d, $ = d = 0, ll = null; Y !== null && $ < y.length; $++) {
        Y.index > $ ? (ll = Y, Y = null) : ll = Y.sibling;
        var ul = g(
          h,
          Y,
          y[$],
          z
        );
        if (ul === null) {
          Y === null && (Y = ll);
          break;
        }
        l && Y && ul.alternate === null && t(h, Y), d = n(ul, d, $), al === null ? G = ul : al.sibling = ul, al = ul, Y = ll;
      }
      if ($ === y.length)
        return e(h, Y), el && Bt(h, $), G;
      if (Y === null) {
        for (; $ < y.length; $++)
          Y = j(h, y[$], z), Y !== null && (d = n(
            Y,
            d,
            $
          ), al === null ? G = Y : al.sibling = Y, al = Y);
        return el && Bt(h, $), G;
      }
      for (Y = a(Y); $ < y.length; $++)
        ll = b(
          Y,
          h,
          $,
          y[$],
          z
        ), ll !== null && (l && ll.alternate !== null && Y.delete(
          ll.key === null ? $ : ll.key
        ), d = n(
          ll,
          d,
          $
        ), al === null ? G = ll : al.sibling = ll, al = ll);
      return l && Y.forEach(function(je) {
        return t(h, je);
      }), el && Bt(h, $), G;
    }
    function L(h, d, y, z) {
      if (y == null) throw Error(m(151));
      for (var G = null, al = null, Y = d, $ = d = 0, ll = null, ul = y.next(); Y !== null && !ul.done; $++, ul = y.next()) {
        Y.index > $ ? (ll = Y, Y = null) : ll = Y.sibling;
        var je = g(h, Y, ul.value, z);
        if (je === null) {
          Y === null && (Y = ll);
          break;
        }
        l && Y && je.alternate === null && t(h, Y), d = n(je, d, $), al === null ? G = je : al.sibling = je, al = je, Y = ll;
      }
      if (ul.done)
        return e(h, Y), el && Bt(h, $), G;
      if (Y === null) {
        for (; !ul.done; $++, ul = y.next())
          ul = j(h, ul.value, z), ul !== null && (d = n(ul, d, $), al === null ? G = ul : al.sibling = ul, al = ul);
        return el && Bt(h, $), G;
      }
      for (Y = a(Y); !ul.done; $++, ul = y.next())
        ul = b(Y, h, $, ul.value, z), ul !== null && (l && ul.alternate !== null && Y.delete(ul.key === null ? $ : ul.key), d = n(ul, d, $), al === null ? G = ul : al.sibling = ul, al = ul);
      return l && Y.forEach(function(yy) {
        return t(h, yy);
      }), el && Bt(h, $), G;
    }
    function ml(h, d, y, z) {
      if (typeof y == "object" && y !== null && y.type === xl && y.key === null && (y = y.props.children), typeof y == "object" && y !== null) {
        switch (y.$$typeof) {
          case N:
            l: {
              for (var G = y.key; d !== null; ) {
                if (d.key === G) {
                  if (G = y.type, G === xl) {
                    if (d.tag === 7) {
                      e(
                        h,
                        d.sibling
                      ), z = u(
                        d,
                        y.props.children
                      ), z.return = h, h = z;
                      break l;
                    }
                  } else if (d.elementType === G || typeof G == "object" && G !== null && G.$$typeof === Cl && Ge(G) === d.type) {
                    e(
                      h,
                      d.sibling
                    ), z = u(d, y.props), lu(z, y), z.return = h, h = z;
                    break l;
                  }
                  e(h, d);
                  break;
                } else t(h, d);
                d = d.sibling;
              }
              y.type === xl ? (z = Ce(
                y.props.children,
                h.mode,
                z,
                y.key
              ), z.return = h, h = z) : (z = Fu(
                y.type,
                y.key,
                y.props,
                null,
                h.mode,
                z
              ), lu(z, y), z.return = h, h = z);
            }
            return i(h);
          case El:
            l: {
              for (G = y.key; d !== null; ) {
                if (d.key === G)
                  if (d.tag === 4 && d.stateNode.containerInfo === y.containerInfo && d.stateNode.implementation === y.implementation) {
                    e(
                      h,
                      d.sibling
                    ), z = u(d, y.children || []), z.return = h, h = z;
                    break l;
                  } else {
                    e(h, d);
                    break;
                  }
                else t(h, d);
                d = d.sibling;
              }
              z = Hi(y, h.mode, z), z.return = h, h = z;
            }
            return i(h);
          case Cl:
            return y = Ge(y), ml(
              h,
              d,
              y,
              z
            );
        }
        if (Tt(y))
          return H(
            h,
            d,
            y,
            z
          );
        if (wl(y)) {
          if (G = wl(y), typeof G != "function") throw Error(m(150));
          return y = G.call(y), L(
            h,
            d,
            y,
            z
          );
        }
        if (typeof y.then == "function")
          return ml(
            h,
            d,
            un(y),
            z
          );
        if (y.$$typeof === Rl)
          return ml(
            h,
            d,
            ln(h, y),
            z
          );
        nn(h, y);
      }
      return typeof y == "string" && y !== "" || typeof y == "number" || typeof y == "bigint" ? (y = "" + y, d !== null && d.tag === 6 ? (e(h, d.sibling), z = u(d, y), z.return = h, h = z) : (e(h, d), z = Ci(y, h.mode, z), z.return = h, h = z), i(h)) : e(h, d);
    }
    return function(h, d, y, z) {
      try {
        Pa = 0;
        var G = ml(
          h,
          d,
          y,
          z
        );
        return ya = null, G;
      } catch (Y) {
        if (Y === ha || Y === en) throw Y;
        var al = nt(29, Y, null, h.mode);
        return al.lanes = z, al.return = h, al;
      }
    };
  }
  var Qe = Zs(!0), Vs = Zs(!1), ce = !1;
  function wi(l) {
    l.updateQueue = {
      baseState: l.memoizedState,
      firstBaseUpdate: null,
      lastBaseUpdate: null,
      shared: { pending: null, lanes: 0, hiddenCallbacks: null },
      callbacks: null
    };
  }
  function $i(l, t) {
    l = l.updateQueue, t.updateQueue === l && (t.updateQueue = {
      baseState: l.baseState,
      firstBaseUpdate: l.firstBaseUpdate,
      lastBaseUpdate: l.lastBaseUpdate,
      shared: l.shared,
      callbacks: null
    });
  }
  function fe(l) {
    return { lane: l, tag: 0, payload: null, callback: null, next: null };
  }
  function se(l, t, e) {
    var a = l.updateQueue;
    if (a === null) return null;
    if (a = a.shared, (nl & 2) !== 0) {
      var u = a.pending;
      return u === null ? t.next = t : (t.next = u.next, u.next = t), a.pending = t, t = ku(l), Ns(l, null, e), t;
    }
    return Wu(l, a, t, e), ku(l);
  }
  function tu(l, t, e) {
    if (t = t.updateQueue, t !== null && (t = t.shared, (e & 4194048) !== 0)) {
      var a = t.lanes;
      a &= l.pendingLanes, e |= a, t.lanes = e, Hf(l, e);
    }
  }
  function Wi(l, t) {
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
  var ki = !1;
  function eu() {
    if (ki) {
      var l = ma;
      if (l !== null) throw l;
    }
  }
  function au(l, t, e, a) {
    ki = !1;
    var u = l.updateQueue;
    ce = !1;
    var n = u.firstBaseUpdate, i = u.lastBaseUpdate, c = u.shared.pending;
    if (c !== null) {
      u.shared.pending = null;
      var s = c, v = s.next;
      s.next = null, i === null ? n = v : i.next = v, i = s;
      var p = l.alternate;
      p !== null && (p = p.updateQueue, c = p.lastBaseUpdate, c !== i && (c === null ? p.firstBaseUpdate = v : c.next = v, p.lastBaseUpdate = s));
    }
    if (n !== null) {
      var j = u.baseState;
      i = 0, p = v = s = null, c = n;
      do {
        var g = c.lane & -536870913, b = g !== c.lane;
        if (b ? (P & g) === g : (a & g) === g) {
          g !== 0 && g === ra && (ki = !0), p !== null && (p = p.next = {
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
                j = T({}, j, g);
                break l;
              case 2:
                ce = !0;
            }
          }
          g = c.callback, g !== null && (l.flags |= 64, b && (l.flags |= 8192), b = u.callbacks, b === null ? u.callbacks = [g] : b.push(g));
        } else
          b = {
            lane: g,
            tag: c.tag,
            payload: c.payload,
            callback: c.callback,
            next: null
          }, p === null ? (v = p = b, s = j) : p = p.next = b, i |= g;
        if (c = c.next, c === null) {
          if (c = u.shared.pending, c === null)
            break;
          b = c, c = b.next, b.next = null, u.lastBaseUpdate = b, u.shared.pending = null;
        }
      } while (!0);
      p === null && (s = j), u.baseState = s, u.firstBaseUpdate = v, u.lastBaseUpdate = p, n === null && (u.shared.lanes = 0), he |= i, l.lanes = i, l.memoizedState = j;
    }
  }
  function Ks(l, t) {
    if (typeof l != "function")
      throw Error(m(191, l));
    l.call(t);
  }
  function Js(l, t) {
    var e = l.callbacks;
    if (e !== null)
      for (l.callbacks = null, l = 0; l < e.length; l++)
        Ks(e[l], t);
  }
  var va = r(null), cn = r(0);
  function ws(l, t) {
    l = $t, R(cn, l), R(va, t), $t = l | t.baseLanes;
  }
  function Fi() {
    R(cn, $t), R(va, va.current);
  }
  function Ii() {
    $t = cn.current, x(va), x(cn);
  }
  var it = r(null), pt = null;
  function oe(l) {
    var t = l.alternate;
    R(Tl, Tl.current & 1), R(it, l), pt === null && (t === null || va.current !== null || t.memoizedState !== null) && (pt = l);
  }
  function Pi(l) {
    R(Tl, Tl.current), R(it, l), pt === null && (pt = l);
  }
  function $s(l) {
    l.tag === 22 ? (R(Tl, Tl.current), R(it, l), pt === null && (pt = l)) : de();
  }
  function de() {
    R(Tl, Tl.current), R(it, it.current);
  }
  function ct(l) {
    x(it), pt === l && (pt = null), x(Tl);
  }
  var Tl = r(0);
  function fn(l) {
    for (var t = l; t !== null; ) {
      if (t.tag === 13) {
        var e = t.memoizedState;
        if (e !== null && (e = e.dehydrated, e === null || nf(e) || cf(e)))
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
  var Lt = 0, J = null, dl = null, _l = null, sn = !1, ga = !1, Xe = !1, on = 0, uu = 0, ba = null, nh = 0;
  function pl() {
    throw Error(m(321));
  }
  function lc(l, t) {
    if (t === null) return !1;
    for (var e = 0; e < t.length && e < l.length; e++)
      if (!ut(l[e], t[e])) return !1;
    return !0;
  }
  function tc(l, t, e, a, u, n) {
    return Lt = n, J = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, A.H = l === null || l.memoizedState === null ? Uo : vc, Xe = !1, n = e(a, u), Xe = !1, ga && (n = ks(
      t,
      e,
      a,
      u
    )), Ws(l), n;
  }
  function Ws(l) {
    A.H = cu;
    var t = dl !== null && dl.next !== null;
    if (Lt = 0, _l = dl = J = null, sn = !1, uu = 0, ba = null, t) throw Error(m(300));
    l === null || Ml || (l = l.dependencies, l !== null && Pu(l) && (Ml = !0));
  }
  function ks(l, t, e, a) {
    J = l;
    var u = 0;
    do {
      if (ga && (ba = null), uu = 0, ga = !1, 25 <= u) throw Error(m(301));
      if (u += 1, _l = dl = null, l.updateQueue != null) {
        var n = l.updateQueue;
        n.lastEffect = null, n.events = null, n.stores = null, n.memoCache != null && (n.memoCache.index = 0);
      }
      A.H = Ro, n = t(e, a);
    } while (ga);
    return n;
  }
  function ih() {
    var l = A.H, t = l.useState()[0];
    return t = typeof t.then == "function" ? nu(t) : t, l = l.useState()[0], (dl !== null ? dl.memoizedState : null) !== l && (J.flags |= 1024), t;
  }
  function ec() {
    var l = on !== 0;
    return on = 0, l;
  }
  function ac(l, t, e) {
    t.updateQueue = l.updateQueue, t.flags &= -2053, l.lanes &= ~e;
  }
  function uc(l) {
    if (sn) {
      for (l = l.memoizedState; l !== null; ) {
        var t = l.queue;
        t !== null && (t.pending = null), l = l.next;
      }
      sn = !1;
    }
    Lt = 0, _l = dl = J = null, ga = !1, uu = on = 0, ba = null;
  }
  function Vl() {
    var l = {
      memoizedState: null,
      baseState: null,
      baseQueue: null,
      queue: null,
      next: null
    };
    return _l === null ? J.memoizedState = _l = l : _l = _l.next = l, _l;
  }
  function jl() {
    if (dl === null) {
      var l = J.alternate;
      l = l !== null ? l.memoizedState : null;
    } else l = dl.next;
    var t = _l === null ? J.memoizedState : _l.next;
    if (t !== null)
      _l = t, dl = l;
    else {
      if (l === null)
        throw J.alternate === null ? Error(m(467)) : Error(m(310));
      dl = l, l = {
        memoizedState: dl.memoizedState,
        baseState: dl.baseState,
        baseQueue: dl.baseQueue,
        queue: dl.queue,
        next: null
      }, _l === null ? J.memoizedState = _l = l : _l = _l.next = l;
    }
    return _l;
  }
  function dn() {
    return { lastEffect: null, events: null, stores: null, memoCache: null };
  }
  function nu(l) {
    var t = uu;
    return uu += 1, ba === null && (ba = []), l = Ls(ba, l, t), t = J, (_l === null ? t.memoizedState : _l.next) === null && (t = t.alternate, A.H = t === null || t.memoizedState === null ? Uo : vc), l;
  }
  function rn(l) {
    if (l !== null && typeof l == "object") {
      if (typeof l.then == "function") return nu(l);
      if (l.$$typeof === Rl) return Gl(l);
    }
    throw Error(m(438, String(l)));
  }
  function nc(l) {
    var t = null, e = J.updateQueue;
    if (e !== null && (t = e.memoCache), t == null) {
      var a = J.alternate;
      a !== null && (a = a.updateQueue, a !== null && (a = a.memoCache, a != null && (t = {
        data: a.data.map(function(u) {
          return u.slice();
        }),
        index: 0
      })));
    }
    if (t == null && (t = { data: [], index: 0 }), e === null && (e = dn(), J.updateQueue = e), e.memoCache = t, e = t.data[t.index], e === void 0)
      for (e = t.data[t.index] = Array(l), a = 0; a < l; a++)
        e[a] = we;
    return t.index++, e;
  }
  function Qt(l, t) {
    return typeof t == "function" ? t(l) : t;
  }
  function mn(l) {
    var t = jl();
    return ic(t, dl, l);
  }
  function ic(l, t, e) {
    var a = l.queue;
    if (a === null) throw Error(m(311));
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
      var c = i = null, s = null, v = t, p = !1;
      do {
        var j = v.lane & -536870913;
        if (j !== v.lane ? (P & j) === j : (Lt & j) === j) {
          var g = v.revertLane;
          if (g === 0)
            s !== null && (s = s.next = {
              lane: 0,
              revertLane: 0,
              gesture: null,
              action: v.action,
              hasEagerState: v.hasEagerState,
              eagerState: v.eagerState,
              next: null
            }), j === ra && (p = !0);
          else if ((Lt & g) === g) {
            v = v.next, g === ra && (p = !0);
            continue;
          } else
            j = {
              lane: 0,
              revertLane: v.revertLane,
              gesture: null,
              action: v.action,
              hasEagerState: v.hasEagerState,
              eagerState: v.eagerState,
              next: null
            }, s === null ? (c = s = j, i = n) : s = s.next = j, J.lanes |= g, he |= g;
          j = v.action, Xe && e(n, j), n = v.hasEagerState ? v.eagerState : e(n, j);
        } else
          g = {
            lane: j,
            revertLane: v.revertLane,
            gesture: v.gesture,
            action: v.action,
            hasEagerState: v.hasEagerState,
            eagerState: v.eagerState,
            next: null
          }, s === null ? (c = s = g, i = n) : s = s.next = g, J.lanes |= j, he |= j;
        v = v.next;
      } while (v !== null && v !== t);
      if (s === null ? i = n : s.next = c, !ut(n, l.memoizedState) && (Ml = !0, p && (e = ma, e !== null)))
        throw e;
      l.memoizedState = n, l.baseState = i, l.baseQueue = s, a.lastRenderedState = n;
    }
    return u === null && (a.lanes = 0), [l.memoizedState, a.dispatch];
  }
  function cc(l) {
    var t = jl(), e = t.queue;
    if (e === null) throw Error(m(311));
    e.lastRenderedReducer = l;
    var a = e.dispatch, u = e.pending, n = t.memoizedState;
    if (u !== null) {
      e.pending = null;
      var i = u = u.next;
      do
        n = l(n, i.action), i = i.next;
      while (i !== u);
      ut(n, t.memoizedState) || (Ml = !0), t.memoizedState = n, t.baseQueue === null && (t.baseState = n), e.lastRenderedState = n;
    }
    return [n, a];
  }
  function Fs(l, t, e) {
    var a = J, u = jl(), n = el;
    if (n) {
      if (e === void 0) throw Error(m(407));
      e = e();
    } else e = t();
    var i = !ut(
      (dl || u).memoizedState,
      e
    );
    if (i && (u.memoizedState = e, Ml = !0), u = u.queue, oc(lo.bind(null, a, u, l), [
      l
    ]), u.getSnapshot !== t || i || _l !== null && _l.memoizedState.tag & 1) {
      if (a.flags |= 2048, Sa(
        9,
        { destroy: void 0 },
        Ps.bind(
          null,
          a,
          u,
          e,
          t
        ),
        null
      ), yl === null) throw Error(m(349));
      n || (Lt & 127) !== 0 || Is(a, t, e);
    }
    return e;
  }
  function Is(l, t, e) {
    l.flags |= 16384, l = { getSnapshot: t, value: e }, t = J.updateQueue, t === null ? (t = dn(), J.updateQueue = t, t.stores = [l]) : (e = t.stores, e === null ? t.stores = [l] : e.push(l));
  }
  function Ps(l, t, e, a) {
    t.value = e, t.getSnapshot = a, to(t) && eo(l);
  }
  function lo(l, t, e) {
    return e(function() {
      to(t) && eo(l);
    });
  }
  function to(l) {
    var t = l.getSnapshot;
    l = l.value;
    try {
      var e = t();
      return !ut(l, e);
    } catch {
      return !0;
    }
  }
  function eo(l) {
    var t = Re(l, 2);
    t !== null && lt(t, l, 2);
  }
  function fc(l) {
    var t = Vl();
    if (typeof l == "function") {
      var e = l;
      if (l = e(), Xe) {
        le(!0);
        try {
          e();
        } finally {
          le(!1);
        }
      }
    }
    return t.memoizedState = t.baseState = l, t.queue = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: Qt,
      lastRenderedState: l
    }, t;
  }
  function ao(l, t, e, a) {
    return l.baseState = e, ic(
      l,
      dl,
      typeof a == "function" ? a : Qt
    );
  }
  function ch(l, t, e, a, u) {
    if (vn(l)) throw Error(m(485));
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
      A.T !== null ? e(!0) : n.isTransition = !1, a(n), e = t.pending, e === null ? (n.next = t.pending = n, uo(t, n)) : (n.next = e.next, t.pending = e.next = n);
    }
  }
  function uo(l, t) {
    var e = t.action, a = t.payload, u = l.state;
    if (t.isTransition) {
      var n = A.T, i = {};
      A.T = i;
      try {
        var c = e(u, a), s = A.S;
        s !== null && s(i, c), no(l, t, c);
      } catch (v) {
        sc(l, t, v);
      } finally {
        n !== null && i.types !== null && (n.types = i.types), A.T = n;
      }
    } else
      try {
        n = e(u, a), no(l, t, n);
      } catch (v) {
        sc(l, t, v);
      }
  }
  function no(l, t, e) {
    e !== null && typeof e == "object" && typeof e.then == "function" ? e.then(
      function(a) {
        io(l, t, a);
      },
      function(a) {
        return sc(l, t, a);
      }
    ) : io(l, t, e);
  }
  function io(l, t, e) {
    t.status = "fulfilled", t.value = e, co(t), l.state = e, t = l.pending, t !== null && (e = t.next, e === t ? l.pending = null : (e = e.next, t.next = e, uo(l, e)));
  }
  function sc(l, t, e) {
    var a = l.pending;
    if (l.pending = null, a !== null) {
      a = a.next;
      do
        t.status = "rejected", t.reason = e, co(t), t = t.next;
      while (t !== a);
    }
    l.action = null;
  }
  function co(l) {
    l = l.listeners;
    for (var t = 0; t < l.length; t++) (0, l[t])();
  }
  function fo(l, t) {
    return t;
  }
  function so(l, t) {
    if (el) {
      var e = yl.formState;
      if (e !== null) {
        l: {
          var a = J;
          if (el) {
            if (vl) {
              t: {
                for (var u = vl, n = St; u.nodeType !== 8; ) {
                  if (!n) {
                    u = null;
                    break t;
                  }
                  if (u = At(
                    u.nextSibling
                  ), u === null) {
                    u = null;
                    break t;
                  }
                }
                n = u.data, u = n === "F!" || n === "F" ? u : null;
              }
              if (u) {
                vl = At(
                  u.nextSibling
                ), a = u.data === "F!";
                break l;
              }
            }
            ne(a);
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
      lastRenderedReducer: fo,
      lastRenderedState: t
    }, e.queue = a, e = _o.bind(
      null,
      J,
      a
    ), a.dispatch = e, a = fc(!1), n = yc.bind(
      null,
      J,
      !1,
      a.queue
    ), a = Vl(), u = {
      state: t,
      dispatch: null,
      action: l,
      pending: null
    }, a.queue = u, e = ch.bind(
      null,
      J,
      u,
      n,
      e
    ), u.dispatch = e, a.memoizedState = l, [t, e, !1];
  }
  function oo(l) {
    var t = jl();
    return ro(t, dl, l);
  }
  function ro(l, t, e) {
    if (t = ic(
      l,
      t,
      fo
    )[0], l = mn(Qt)[0], typeof t == "object" && t !== null && typeof t.then == "function")
      try {
        var a = nu(t);
      } catch (i) {
        throw i === ha ? en : i;
      }
    else a = t;
    t = jl();
    var u = t.queue, n = u.dispatch;
    return e !== t.memoizedState && (J.flags |= 2048, Sa(
      9,
      { destroy: void 0 },
      fh.bind(null, u, e),
      null
    )), [a, n, l];
  }
  function fh(l, t) {
    l.action = t;
  }
  function mo(l) {
    var t = jl(), e = dl;
    if (e !== null)
      return ro(t, e, l);
    jl(), t = t.memoizedState, e = jl();
    var a = e.queue.dispatch;
    return e.memoizedState = l, [t, a, !1];
  }
  function Sa(l, t, e, a) {
    return l = { tag: l, create: e, deps: a, inst: t, next: null }, t = J.updateQueue, t === null && (t = dn(), J.updateQueue = t), e = t.lastEffect, e === null ? t.lastEffect = l.next = l : (a = e.next, e.next = l, l.next = a, t.lastEffect = l), l;
  }
  function ho() {
    return jl().memoizedState;
  }
  function hn(l, t, e, a) {
    var u = Vl();
    J.flags |= l, u.memoizedState = Sa(
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
    dl !== null && a !== null && lc(a, dl.memoizedState.deps) ? u.memoizedState = Sa(t, n, e, a) : (J.flags |= l, u.memoizedState = Sa(
      1 | t,
      n,
      e,
      a
    ));
  }
  function yo(l, t) {
    hn(8390656, 8, l, t);
  }
  function oc(l, t) {
    yn(2048, 8, l, t);
  }
  function sh(l) {
    J.flags |= 4;
    var t = J.updateQueue;
    if (t === null)
      t = dn(), J.updateQueue = t, t.events = [l];
    else {
      var e = t.events;
      e === null ? t.events = [l] : e.push(l);
    }
  }
  function vo(l) {
    var t = jl().memoizedState;
    return sh({ ref: t, nextImpl: l }), function() {
      if ((nl & 2) !== 0) throw Error(m(440));
      return t.impl.apply(void 0, arguments);
    };
  }
  function go(l, t) {
    return yn(4, 2, l, t);
  }
  function bo(l, t) {
    return yn(4, 4, l, t);
  }
  function So(l, t) {
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
  function po(l, t, e) {
    e = e != null ? e.concat([l]) : null, yn(4, 4, So.bind(null, t, l), e);
  }
  function dc() {
  }
  function Ao(l, t) {
    var e = jl();
    t = t === void 0 ? null : t;
    var a = e.memoizedState;
    return t !== null && lc(t, a[1]) ? a[0] : (e.memoizedState = [l, t], l);
  }
  function zo(l, t) {
    var e = jl();
    t = t === void 0 ? null : t;
    var a = e.memoizedState;
    if (t !== null && lc(t, a[1]))
      return a[0];
    if (a = l(), Xe) {
      le(!0);
      try {
        l();
      } finally {
        le(!1);
      }
    }
    return e.memoizedState = [a, t], a;
  }
  function rc(l, t, e) {
    return e === void 0 || (Lt & 1073741824) !== 0 && (P & 261930) === 0 ? l.memoizedState = t : (l.memoizedState = e, l = Td(), J.lanes |= l, he |= l, e);
  }
  function To(l, t, e, a) {
    return ut(e, t) ? e : va.current !== null ? (l = rc(l, e, a), ut(l, t) || (Ml = !0), l) : (Lt & 42) === 0 || (Lt & 1073741824) !== 0 && (P & 261930) === 0 ? (Ml = !0, l.memoizedState = e) : (l = Td(), J.lanes |= l, he |= l, t);
  }
  function jo(l, t, e, a, u) {
    var n = U.p;
    U.p = n !== 0 && 8 > n ? n : 8;
    var i = A.T, c = {};
    A.T = c, yc(l, !1, t, e);
    try {
      var s = u(), v = A.S;
      if (v !== null && v(c, s), s !== null && typeof s == "object" && typeof s.then == "function") {
        var p = uh(
          s,
          a
        );
        iu(
          l,
          t,
          p,
          ot(l)
        );
      } else
        iu(
          l,
          t,
          a,
          ot(l)
        );
    } catch (j) {
      iu(
        l,
        t,
        { then: function() {
        }, status: "rejected", reason: j },
        ot()
      );
    } finally {
      U.p = n, i !== null && c.types !== null && (i.types = c.types), A.T = i;
    }
  }
  function oh() {
  }
  function mc(l, t, e, a) {
    if (l.tag !== 5) throw Error(m(476));
    var u = Eo(l).queue;
    jo(
      l,
      u,
      t,
      Z,
      e === null ? oh : function() {
        return xo(l), e(a);
      }
    );
  }
  function Eo(l) {
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
        lastRenderedReducer: Qt,
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
        lastRenderedReducer: Qt,
        lastRenderedState: e
      },
      next: null
    }, l.memoizedState = t, l = l.alternate, l !== null && (l.memoizedState = t), t;
  }
  function xo(l) {
    var t = Eo(l);
    t.next === null && (t = l.alternate.memoizedState), iu(
      l,
      t.next.queue,
      {},
      ot()
    );
  }
  function hc() {
    return Gl(Tu);
  }
  function No() {
    return jl().memoizedState;
  }
  function Oo() {
    return jl().memoizedState;
  }
  function dh(l) {
    for (var t = l.return; t !== null; ) {
      switch (t.tag) {
        case 24:
        case 3:
          var e = ot();
          l = fe(e);
          var a = se(t, l, e);
          a !== null && (lt(a, t, e), tu(a, t, e)), t = { cache: Zi() }, l.payload = t;
          return;
      }
      t = t.return;
    }
  }
  function rh(l, t, e) {
    var a = ot();
    e = {
      lane: a,
      revertLane: 0,
      gesture: null,
      action: e,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, vn(l) ? Mo(t, e) : (e = Ui(l, t, e, a), e !== null && (lt(e, l, a), Do(e, t, a)));
  }
  function _o(l, t, e) {
    var a = ot();
    iu(l, t, e, a);
  }
  function iu(l, t, e, a) {
    var u = {
      lane: a,
      revertLane: 0,
      gesture: null,
      action: e,
      hasEagerState: !1,
      eagerState: null,
      next: null
    };
    if (vn(l)) Mo(t, u);
    else {
      var n = l.alternate;
      if (l.lanes === 0 && (n === null || n.lanes === 0) && (n = t.lastRenderedReducer, n !== null))
        try {
          var i = t.lastRenderedState, c = n(i, e);
          if (u.hasEagerState = !0, u.eagerState = c, ut(c, i))
            return Wu(l, t, u, 0), yl === null && $u(), !1;
        } catch {
        }
      if (e = Ui(l, t, u, a), e !== null)
        return lt(e, l, a), Do(e, t, a), !0;
    }
    return !1;
  }
  function yc(l, t, e, a) {
    if (a = {
      lane: 2,
      revertLane: wc(),
      gesture: null,
      action: a,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, vn(l)) {
      if (t) throw Error(m(479));
    } else
      t = Ui(
        l,
        e,
        a,
        2
      ), t !== null && lt(t, l, 2);
  }
  function vn(l) {
    var t = l.alternate;
    return l === J || t !== null && t === J;
  }
  function Mo(l, t) {
    ga = sn = !0;
    var e = l.pending;
    e === null ? t.next = t : (t.next = e.next, e.next = t), l.pending = t;
  }
  function Do(l, t, e) {
    if ((e & 4194048) !== 0) {
      var a = t.lanes;
      a &= l.pendingLanes, e |= a, t.lanes = e, Hf(l, e);
    }
  }
  var cu = {
    readContext: Gl,
    use: rn,
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
  cu.useEffectEvent = pl;
  var Uo = {
    readContext: Gl,
    use: rn,
    useCallback: function(l, t) {
      return Vl().memoizedState = [
        l,
        t === void 0 ? null : t
      ], l;
    },
    useContext: Gl,
    useEffect: yo,
    useImperativeHandle: function(l, t, e) {
      e = e != null ? e.concat([l]) : null, hn(
        4194308,
        4,
        So.bind(null, t, l),
        e
      );
    },
    useLayoutEffect: function(l, t) {
      return hn(4194308, 4, l, t);
    },
    useInsertionEffect: function(l, t) {
      hn(4, 2, l, t);
    },
    useMemo: function(l, t) {
      var e = Vl();
      t = t === void 0 ? null : t;
      var a = l();
      if (Xe) {
        le(!0);
        try {
          l();
        } finally {
          le(!1);
        }
      }
      return e.memoizedState = [a, t], a;
    },
    useReducer: function(l, t, e) {
      var a = Vl();
      if (e !== void 0) {
        var u = e(t);
        if (Xe) {
          le(!0);
          try {
            e(t);
          } finally {
            le(!1);
          }
        }
      } else u = t;
      return a.memoizedState = a.baseState = u, l = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: l,
        lastRenderedState: u
      }, a.queue = l, l = l.dispatch = rh.bind(
        null,
        J,
        l
      ), [a.memoizedState, l];
    },
    useRef: function(l) {
      var t = Vl();
      return l = { current: l }, t.memoizedState = l;
    },
    useState: function(l) {
      l = fc(l);
      var t = l.queue, e = _o.bind(null, J, t);
      return t.dispatch = e, [l.memoizedState, e];
    },
    useDebugValue: dc,
    useDeferredValue: function(l, t) {
      var e = Vl();
      return rc(e, l, t);
    },
    useTransition: function() {
      var l = fc(!1);
      return l = jo.bind(
        null,
        J,
        l.queue,
        !0,
        !1
      ), Vl().memoizedState = l, [!1, l];
    },
    useSyncExternalStore: function(l, t, e) {
      var a = J, u = Vl();
      if (el) {
        if (e === void 0)
          throw Error(m(407));
        e = e();
      } else {
        if (e = t(), yl === null)
          throw Error(m(349));
        (P & 127) !== 0 || Is(a, t, e);
      }
      u.memoizedState = e;
      var n = { value: e, getSnapshot: t };
      return u.queue = n, yo(lo.bind(null, a, n, l), [
        l
      ]), a.flags |= 2048, Sa(
        9,
        { destroy: void 0 },
        Ps.bind(
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
      var l = Vl(), t = yl.identifierPrefix;
      if (el) {
        var e = _t, a = Ot;
        e = (a & ~(1 << 32 - at(a) - 1)).toString(32) + e, t = "_" + t + "R_" + e, e = on++, 0 < e && (t += "H" + e.toString(32)), t += "_";
      } else
        e = nh++, t = "_" + t + "r_" + e.toString(32) + "_";
      return l.memoizedState = t;
    },
    useHostTransitionStatus: hc,
    useFormState: so,
    useActionState: so,
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
      return t.queue = e, t = yc.bind(
        null,
        J,
        !0,
        e
      ), e.dispatch = t, [l, t];
    },
    useMemoCache: nc,
    useCacheRefresh: function() {
      return Vl().memoizedState = dh.bind(
        null,
        J
      );
    },
    useEffectEvent: function(l) {
      var t = Vl(), e = { impl: l };
      return t.memoizedState = e, function() {
        if ((nl & 2) !== 0)
          throw Error(m(440));
        return e.impl.apply(void 0, arguments);
      };
    }
  }, vc = {
    readContext: Gl,
    use: rn,
    useCallback: Ao,
    useContext: Gl,
    useEffect: oc,
    useImperativeHandle: po,
    useInsertionEffect: go,
    useLayoutEffect: bo,
    useMemo: zo,
    useReducer: mn,
    useRef: ho,
    useState: function() {
      return mn(Qt);
    },
    useDebugValue: dc,
    useDeferredValue: function(l, t) {
      var e = jl();
      return To(
        e,
        dl.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = mn(Qt)[0], t = jl().memoizedState;
      return [
        typeof l == "boolean" ? l : nu(l),
        t
      ];
    },
    useSyncExternalStore: Fs,
    useId: No,
    useHostTransitionStatus: hc,
    useFormState: oo,
    useActionState: oo,
    useOptimistic: function(l, t) {
      var e = jl();
      return ao(e, dl, l, t);
    },
    useMemoCache: nc,
    useCacheRefresh: Oo
  };
  vc.useEffectEvent = vo;
  var Ro = {
    readContext: Gl,
    use: rn,
    useCallback: Ao,
    useContext: Gl,
    useEffect: oc,
    useImperativeHandle: po,
    useInsertionEffect: go,
    useLayoutEffect: bo,
    useMemo: zo,
    useReducer: cc,
    useRef: ho,
    useState: function() {
      return cc(Qt);
    },
    useDebugValue: dc,
    useDeferredValue: function(l, t) {
      var e = jl();
      return dl === null ? rc(e, l, t) : To(
        e,
        dl.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = cc(Qt)[0], t = jl().memoizedState;
      return [
        typeof l == "boolean" ? l : nu(l),
        t
      ];
    },
    useSyncExternalStore: Fs,
    useId: No,
    useHostTransitionStatus: hc,
    useFormState: mo,
    useActionState: mo,
    useOptimistic: function(l, t) {
      var e = jl();
      return dl !== null ? ao(e, dl, l, t) : (e.baseState = l, [l, e.queue.dispatch]);
    },
    useMemoCache: nc,
    useCacheRefresh: Oo
  };
  Ro.useEffectEvent = vo;
  function gc(l, t, e, a) {
    t = l.memoizedState, e = e(a, t), e = e == null ? t : T({}, t, e), l.memoizedState = e, l.lanes === 0 && (l.updateQueue.baseState = e);
  }
  var bc = {
    enqueueSetState: function(l, t, e) {
      l = l._reactInternals;
      var a = ot(), u = fe(a);
      u.payload = t, e != null && (u.callback = e), t = se(l, u, a), t !== null && (lt(t, l, a), tu(t, l, a));
    },
    enqueueReplaceState: function(l, t, e) {
      l = l._reactInternals;
      var a = ot(), u = fe(a);
      u.tag = 1, u.payload = t, e != null && (u.callback = e), t = se(l, u, a), t !== null && (lt(t, l, a), tu(t, l, a));
    },
    enqueueForceUpdate: function(l, t) {
      l = l._reactInternals;
      var e = ot(), a = fe(e);
      a.tag = 2, t != null && (a.callback = t), t = se(l, a, e), t !== null && (lt(t, l, e), tu(t, l, e));
    }
  };
  function Co(l, t, e, a, u, n, i) {
    return l = l.stateNode, typeof l.shouldComponentUpdate == "function" ? l.shouldComponentUpdate(a, n, i) : t.prototype && t.prototype.isPureReactComponent ? !wa(e, a) || !wa(u, n) : !0;
  }
  function Ho(l, t, e, a) {
    l = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(e, a), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(e, a), t.state !== l && bc.enqueueReplaceState(t, t.state, null);
  }
  function Ze(l, t) {
    var e = t;
    if ("ref" in t) {
      e = {};
      for (var a in t)
        a !== "ref" && (e[a] = t[a]);
    }
    if (l = l.defaultProps) {
      e === t && (e = T({}, e));
      for (var u in l)
        e[u] === void 0 && (e[u] = l[u]);
    }
    return e;
  }
  function qo(l) {
    wu(l);
  }
  function Bo(l) {
    console.error(l);
  }
  function Yo(l) {
    wu(l);
  }
  function gn(l, t) {
    try {
      var e = l.onUncaughtError;
      e(t.value, { componentStack: t.stack });
    } catch (a) {
      setTimeout(function() {
        throw a;
      });
    }
  }
  function Go(l, t, e) {
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
  function Sc(l, t, e) {
    return e = fe(e), e.tag = 3, e.payload = { element: null }, e.callback = function() {
      gn(l, t);
    }, e;
  }
  function Lo(l) {
    return l = fe(l), l.tag = 3, l;
  }
  function Qo(l, t, e, a) {
    var u = e.type.getDerivedStateFromError;
    if (typeof u == "function") {
      var n = a.value;
      l.payload = function() {
        return u(n);
      }, l.callback = function() {
        Go(t, e, a);
      };
    }
    var i = e.stateNode;
    i !== null && typeof i.componentDidCatch == "function" && (l.callback = function() {
      Go(t, e, a), typeof u != "function" && (ye === null ? ye = /* @__PURE__ */ new Set([this]) : ye.add(this));
      var c = a.stack;
      this.componentDidCatch(a.value, {
        componentStack: c !== null ? c : ""
      });
    });
  }
  function mh(l, t, e, a, u) {
    if (e.flags |= 32768, a !== null && typeof a == "object" && typeof a.then == "function") {
      if (t = e.alternate, t !== null && da(
        t,
        e,
        u,
        !0
      ), e = it.current, e !== null) {
        switch (e.tag) {
          case 31:
          case 13:
            return pt === null ? _n() : e.alternate === null && Al === 0 && (Al = 3), e.flags &= -257, e.flags |= 65536, e.lanes = u, a === an ? e.flags |= 16384 : (t = e.updateQueue, t === null ? e.updateQueue = /* @__PURE__ */ new Set([a]) : t.add(a), Vc(l, a, u)), !1;
          case 22:
            return e.flags |= 65536, a === an ? e.flags |= 16384 : (t = e.updateQueue, t === null ? (t = {
              transitions: null,
              markerInstances: null,
              retryQueue: /* @__PURE__ */ new Set([a])
            }, e.updateQueue = t) : (e = t.retryQueue, e === null ? t.retryQueue = /* @__PURE__ */ new Set([a]) : e.add(a)), Vc(l, a, u)), !1;
        }
        throw Error(m(435, e.tag));
      }
      return Vc(l, a, u), _n(), !1;
    }
    if (el)
      return t = it.current, t !== null ? ((t.flags & 65536) === 0 && (t.flags |= 256), t.flags |= 65536, t.lanes = u, a !== Yi && (l = Error(m(422), { cause: a }), ka(vt(l, e)))) : (a !== Yi && (t = Error(m(423), {
        cause: a
      }), ka(
        vt(t, e)
      )), l = l.current.alternate, l.flags |= 65536, u &= -u, l.lanes |= u, a = vt(a, e), u = Sc(
        l.stateNode,
        a,
        u
      ), Wi(l, u), Al !== 4 && (Al = 2)), !1;
    var n = Error(m(520), { cause: a });
    if (n = vt(n, e), yu === null ? yu = [n] : yu.push(n), Al !== 4 && (Al = 2), t === null) return !0;
    a = vt(a, e), e = t;
    do {
      switch (e.tag) {
        case 3:
          return e.flags |= 65536, l = u & -u, e.lanes |= l, l = Sc(e.stateNode, a, l), Wi(e, l), !1;
        case 1:
          if (t = e.type, n = e.stateNode, (e.flags & 128) === 0 && (typeof t.getDerivedStateFromError == "function" || n !== null && typeof n.componentDidCatch == "function" && (ye === null || !ye.has(n))))
            return e.flags |= 65536, u &= -u, e.lanes |= u, u = Lo(u), Qo(
              u,
              l,
              e,
              a
            ), Wi(e, u), !1;
      }
      e = e.return;
    } while (e !== null);
    return !1;
  }
  var pc = Error(m(461)), Ml = !1;
  function Ll(l, t, e, a) {
    t.child = l === null ? Vs(t, null, e, a) : Qe(
      t,
      l.child,
      e,
      a
    );
  }
  function Xo(l, t, e, a, u) {
    e = e.render;
    var n = t.ref;
    if ("ref" in a) {
      var i = {};
      for (var c in a)
        c !== "ref" && (i[c] = a[c]);
    } else i = a;
    return Be(t), a = tc(
      l,
      t,
      e,
      i,
      n,
      u
    ), c = ec(), l !== null && !Ml ? (ac(l, t, u), Xt(l, t, u)) : (el && c && qi(t), t.flags |= 1, Ll(l, t, a, u), t.child);
  }
  function Zo(l, t, e, a, u) {
    if (l === null) {
      var n = e.type;
      return typeof n == "function" && !Ri(n) && n.defaultProps === void 0 && e.compare === null ? (t.tag = 15, t.type = n, Vo(
        l,
        t,
        n,
        a,
        u
      )) : (l = Fu(
        e.type,
        null,
        a,
        t,
        t.mode,
        u
      ), l.ref = t.ref, l.return = t, t.child = l);
    }
    if (n = l.child, !Oc(l, u)) {
      var i = n.memoizedProps;
      if (e = e.compare, e = e !== null ? e : wa, e(i, a) && l.ref === t.ref)
        return Xt(l, t, u);
    }
    return t.flags |= 1, l = qt(n, a), l.ref = t.ref, l.return = t, t.child = l;
  }
  function Vo(l, t, e, a, u) {
    if (l !== null) {
      var n = l.memoizedProps;
      if (wa(n, a) && l.ref === t.ref)
        if (Ml = !1, t.pendingProps = a = n, Oc(l, u))
          (l.flags & 131072) !== 0 && (Ml = !0);
        else
          return t.lanes = l.lanes, Xt(l, t, u);
    }
    return Ac(
      l,
      t,
      e,
      a,
      u
    );
  }
  function Ko(l, t, e, a) {
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
        return Jo(
          l,
          t,
          n,
          e,
          a
        );
      }
      if ((e & 536870912) !== 0)
        t.memoizedState = { baseLanes: 0, cachePool: null }, l !== null && tn(
          t,
          n !== null ? n.cachePool : null
        ), n !== null ? ws(t, n) : Fi(), $s(t);
      else
        return a = t.lanes = 536870912, Jo(
          l,
          t,
          n !== null ? n.baseLanes | e : e,
          e,
          a
        );
    } else
      n !== null ? (tn(t, n.cachePool), ws(t, n), de(), t.memoizedState = null) : (l !== null && tn(t, null), Fi(), de());
    return Ll(l, t, u, e), t.child;
  }
  function fu(l, t) {
    return l !== null && l.tag === 22 || t.stateNode !== null || (t.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), t.sibling;
  }
  function Jo(l, t, e, a, u) {
    var n = Ki();
    return n = n === null ? null : { parent: Ol._currentValue, pool: n }, t.memoizedState = {
      baseLanes: e,
      cachePool: n
    }, l !== null && tn(t, null), Fi(), $s(t), l !== null && da(l, t, a, !0), t.childLanes = u, null;
  }
  function bn(l, t) {
    return t = pn(
      { mode: t.mode, children: t.children },
      l.mode
    ), t.ref = l.ref, l.child = t, t.return = l, t;
  }
  function wo(l, t, e) {
    return Qe(t, l.child, null, e), l = bn(t, t.pendingProps), l.flags |= 2, ct(t), t.memoizedState = null, l;
  }
  function hh(l, t, e) {
    var a = t.pendingProps, u = (t.flags & 128) !== 0;
    if (t.flags &= -129, l === null) {
      if (el) {
        if (a.mode === "hidden")
          return l = bn(t, a), t.lanes = 536870912, fu(null, l);
        if (Pi(t), (l = vl) ? (l = nr(
          l,
          St
        ), l = l !== null && l.data === "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ae !== null ? { id: Ot, overflow: _t } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, e = _s(l), e.return = t, t.child = e, Yl = t, vl = null)) : l = null, l === null) throw ne(t);
        return t.lanes = 536870912, null;
      }
      return bn(t, a);
    }
    var n = l.memoizedState;
    if (n !== null) {
      var i = n.dehydrated;
      if (Pi(t), u)
        if (t.flags & 256)
          t.flags &= -257, t = wo(
            l,
            t,
            e
          );
        else if (t.memoizedState !== null)
          t.child = l.child, t.flags |= 128, t = null;
        else throw Error(m(558));
      else if (Ml || da(l, t, e, !1), u = (e & l.childLanes) !== 0, Ml || u) {
        if (a = yl, a !== null && (i = qf(a, e), i !== 0 && i !== n.retryLane))
          throw n.retryLane = i, Re(l, i), lt(a, l, i), pc;
        _n(), t = wo(
          l,
          t,
          e
        );
      } else
        l = n.treeContext, vl = At(i.nextSibling), Yl = t, el = !0, ue = null, St = !1, l !== null && Us(t, l), t = bn(t, a), t.flags |= 4096;
      return t;
    }
    return l = qt(l.child, {
      mode: a.mode,
      children: a.children
    }), l.ref = t.ref, t.child = l, l.return = t, l;
  }
  function Sn(l, t) {
    var e = t.ref;
    if (e === null)
      l !== null && l.ref !== null && (t.flags |= 4194816);
    else {
      if (typeof e != "function" && typeof e != "object")
        throw Error(m(284));
      (l === null || l.ref !== e) && (t.flags |= 4194816);
    }
  }
  function Ac(l, t, e, a, u) {
    return Be(t), e = tc(
      l,
      t,
      e,
      a,
      void 0,
      u
    ), a = ec(), l !== null && !Ml ? (ac(l, t, u), Xt(l, t, u)) : (el && a && qi(t), t.flags |= 1, Ll(l, t, e, u), t.child);
  }
  function $o(l, t, e, a, u, n) {
    return Be(t), t.updateQueue = null, e = ks(
      t,
      a,
      e,
      u
    ), Ws(l), a = ec(), l !== null && !Ml ? (ac(l, t, n), Xt(l, t, n)) : (el && a && qi(t), t.flags |= 1, Ll(l, t, e, n), t.child);
  }
  function Wo(l, t, e, a, u) {
    if (Be(t), t.stateNode === null) {
      var n = ca, i = e.contextType;
      typeof i == "object" && i !== null && (n = Gl(i)), n = new e(a, n), t.memoizedState = n.state !== null && n.state !== void 0 ? n.state : null, n.updater = bc, t.stateNode = n, n._reactInternals = t, n = t.stateNode, n.props = a, n.state = t.memoizedState, n.refs = {}, wi(t), i = e.contextType, n.context = typeof i == "object" && i !== null ? Gl(i) : ca, n.state = t.memoizedState, i = e.getDerivedStateFromProps, typeof i == "function" && (gc(
        t,
        e,
        i,
        a
      ), n.state = t.memoizedState), typeof e.getDerivedStateFromProps == "function" || typeof n.getSnapshotBeforeUpdate == "function" || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (i = n.state, typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount(), i !== n.state && bc.enqueueReplaceState(n, n.state, null), au(t, a, n, u), eu(), n.state = t.memoizedState), typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !0;
    } else if (l === null) {
      n = t.stateNode;
      var c = t.memoizedProps, s = Ze(e, c);
      n.props = s;
      var v = n.context, p = e.contextType;
      i = ca, typeof p == "object" && p !== null && (i = Gl(p));
      var j = e.getDerivedStateFromProps;
      p = typeof j == "function" || typeof n.getSnapshotBeforeUpdate == "function", c = t.pendingProps !== c, p || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (c || v !== i) && Ho(
        t,
        n,
        a,
        i
      ), ce = !1;
      var g = t.memoizedState;
      n.state = g, au(t, a, n, u), eu(), v = t.memoizedState, c || g !== v || ce ? (typeof j == "function" && (gc(
        t,
        e,
        j,
        a
      ), v = t.memoizedState), (s = ce || Co(
        t,
        e,
        s,
        a,
        g,
        v,
        i
      )) ? (p || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount()), typeof n.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = a, t.memoizedState = v), n.props = a, n.state = v, n.context = i, a = s) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !1);
    } else {
      n = t.stateNode, $i(l, t), i = t.memoizedProps, p = Ze(e, i), n.props = p, j = t.pendingProps, g = n.context, v = e.contextType, s = ca, typeof v == "object" && v !== null && (s = Gl(v)), c = e.getDerivedStateFromProps, (v = typeof c == "function" || typeof n.getSnapshotBeforeUpdate == "function") || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (i !== j || g !== s) && Ho(
        t,
        n,
        a,
        s
      ), ce = !1, g = t.memoizedState, n.state = g, au(t, a, n, u), eu();
      var b = t.memoizedState;
      i !== j || g !== b || ce || l !== null && l.dependencies !== null && Pu(l.dependencies) ? (typeof c == "function" && (gc(
        t,
        e,
        c,
        a
      ), b = t.memoizedState), (p = ce || Co(
        t,
        e,
        p,
        a,
        g,
        b,
        s
      ) || l !== null && l.dependencies !== null && Pu(l.dependencies)) ? (v || typeof n.UNSAFE_componentWillUpdate != "function" && typeof n.componentWillUpdate != "function" || (typeof n.componentWillUpdate == "function" && n.componentWillUpdate(a, b, s), typeof n.UNSAFE_componentWillUpdate == "function" && n.UNSAFE_componentWillUpdate(
        a,
        b,
        s
      )), typeof n.componentDidUpdate == "function" && (t.flags |= 4), typeof n.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), t.memoizedProps = a, t.memoizedState = b), n.props = a, n.state = b, n.context = s, a = p) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), a = !1);
    }
    return n = a, Sn(l, t), a = (t.flags & 128) !== 0, n || a ? (n = t.stateNode, e = a && typeof e.getDerivedStateFromError != "function" ? null : n.render(), t.flags |= 1, l !== null && a ? (t.child = Qe(
      t,
      l.child,
      null,
      u
    ), t.child = Qe(
      t,
      null,
      e,
      u
    )) : Ll(l, t, e, u), t.memoizedState = n.state, l = t.child) : l = Xt(
      l,
      t,
      u
    ), l;
  }
  function ko(l, t, e, a) {
    return He(), t.flags |= 256, Ll(l, t, e, a), t.child;
  }
  var zc = {
    dehydrated: null,
    treeContext: null,
    retryLane: 0,
    hydrationErrors: null
  };
  function Tc(l) {
    return { baseLanes: l, cachePool: Ys() };
  }
  function jc(l, t, e) {
    return l = l !== null ? l.childLanes & ~e : 0, t && (l |= st), l;
  }
  function Fo(l, t, e) {
    var a = t.pendingProps, u = !1, n = (t.flags & 128) !== 0, i;
    if ((i = n) || (i = l !== null && l.memoizedState === null ? !1 : (Tl.current & 2) !== 0), i && (u = !0, t.flags &= -129), i = (t.flags & 32) !== 0, t.flags &= -33, l === null) {
      if (el) {
        if (u ? oe(t) : de(), (l = vl) ? (l = nr(
          l,
          St
        ), l = l !== null && l.data !== "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ae !== null ? { id: Ot, overflow: _t } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, e = _s(l), e.return = t, t.child = e, Yl = t, vl = null)) : l = null, l === null) throw ne(t);
        return cf(l) ? t.lanes = 32 : t.lanes = 536870912, null;
      }
      var c = a.children;
      return a = a.fallback, u ? (de(), u = t.mode, c = pn(
        { mode: "hidden", children: c },
        u
      ), a = Ce(
        a,
        u,
        e,
        null
      ), c.return = t, a.return = t, c.sibling = a, t.child = c, a = t.child, a.memoizedState = Tc(e), a.childLanes = jc(
        l,
        i,
        e
      ), t.memoizedState = zc, fu(null, a)) : (oe(t), Ec(t, c));
    }
    var s = l.memoizedState;
    if (s !== null && (c = s.dehydrated, c !== null)) {
      if (n)
        t.flags & 256 ? (oe(t), t.flags &= -257, t = xc(
          l,
          t,
          e
        )) : t.memoizedState !== null ? (de(), t.child = l.child, t.flags |= 128, t = null) : (de(), c = a.fallback, u = t.mode, a = pn(
          { mode: "visible", children: a.children },
          u
        ), c = Ce(
          c,
          u,
          e,
          null
        ), c.flags |= 2, a.return = t, c.return = t, a.sibling = c, t.child = a, Qe(
          t,
          l.child,
          null,
          e
        ), a = t.child, a.memoizedState = Tc(e), a.childLanes = jc(
          l,
          i,
          e
        ), t.memoizedState = zc, t = fu(null, a));
      else if (oe(t), cf(c)) {
        if (i = c.nextSibling && c.nextSibling.dataset, i) var v = i.dgst;
        i = v, a = Error(m(419)), a.stack = "", a.digest = i, ka({ value: a, source: null, stack: null }), t = xc(
          l,
          t,
          e
        );
      } else if (Ml || da(l, t, e, !1), i = (e & l.childLanes) !== 0, Ml || i) {
        if (i = yl, i !== null && (a = qf(i, e), a !== 0 && a !== s.retryLane))
          throw s.retryLane = a, Re(l, a), lt(i, l, a), pc;
        nf(c) || _n(), t = xc(
          l,
          t,
          e
        );
      } else
        nf(c) ? (t.flags |= 192, t.child = l.child, t = null) : (l = s.treeContext, vl = At(
          c.nextSibling
        ), Yl = t, el = !0, ue = null, St = !1, l !== null && Us(t, l), t = Ec(
          t,
          a.children
        ), t.flags |= 4096);
      return t;
    }
    return u ? (de(), c = a.fallback, u = t.mode, s = l.child, v = s.sibling, a = qt(s, {
      mode: "hidden",
      children: a.children
    }), a.subtreeFlags = s.subtreeFlags & 65011712, v !== null ? c = qt(
      v,
      c
    ) : (c = Ce(
      c,
      u,
      e,
      null
    ), c.flags |= 2), c.return = t, a.return = t, a.sibling = c, t.child = a, fu(null, a), a = t.child, c = l.child.memoizedState, c === null ? c = Tc(e) : (u = c.cachePool, u !== null ? (s = Ol._currentValue, u = u.parent !== s ? { parent: s, pool: s } : u) : u = Ys(), c = {
      baseLanes: c.baseLanes | e,
      cachePool: u
    }), a.memoizedState = c, a.childLanes = jc(
      l,
      i,
      e
    ), t.memoizedState = zc, fu(l.child, a)) : (oe(t), e = l.child, l = e.sibling, e = qt(e, {
      mode: "visible",
      children: a.children
    }), e.return = t, e.sibling = null, l !== null && (i = t.deletions, i === null ? (t.deletions = [l], t.flags |= 16) : i.push(l)), t.child = e, t.memoizedState = null, e);
  }
  function Ec(l, t) {
    return t = pn(
      { mode: "visible", children: t },
      l.mode
    ), t.return = l, l.child = t;
  }
  function pn(l, t) {
    return l = nt(22, l, null, t), l.lanes = 0, l;
  }
  function xc(l, t, e) {
    return Qe(t, l.child, null, e), l = Ec(
      t,
      t.pendingProps.children
    ), l.flags |= 2, t.memoizedState = null, l;
  }
  function Io(l, t, e) {
    l.lanes |= t;
    var a = l.alternate;
    a !== null && (a.lanes |= t), Qi(l.return, t, e);
  }
  function Nc(l, t, e, a, u, n) {
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
  function Po(l, t, e) {
    var a = t.pendingProps, u = a.revealOrder, n = a.tail;
    a = a.children;
    var i = Tl.current, c = (i & 2) !== 0;
    if (c ? (i = i & 1 | 2, t.flags |= 128) : i &= 1, R(Tl, i), Ll(l, t, a, e), a = el ? Wa : 0, !c && l !== null && (l.flags & 128) !== 0)
      l: for (l = t.child; l !== null; ) {
        if (l.tag === 13)
          l.memoizedState !== null && Io(l, e, t);
        else if (l.tag === 19)
          Io(l, e, t);
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
          l = e.alternate, l !== null && fn(l) === null && (u = e), e = e.sibling;
        e = u, e === null ? (u = t.child, t.child = null) : (u = e.sibling, e.sibling = null), Nc(
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
          if (l = u.alternate, l !== null && fn(l) === null) {
            t.child = u;
            break;
          }
          l = u.sibling, u.sibling = e, e = u, u = l;
        }
        Nc(
          t,
          !0,
          e,
          null,
          n,
          a
        );
        break;
      case "together":
        Nc(
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
  function Xt(l, t, e) {
    if (l !== null && (t.dependencies = l.dependencies), he |= t.lanes, (e & t.childLanes) === 0)
      if (l !== null) {
        if (da(
          l,
          t,
          e,
          !1
        ), (e & t.childLanes) === 0)
          return null;
      } else return null;
    if (l !== null && t.child !== l.child)
      throw Error(m(153));
    if (t.child !== null) {
      for (l = t.child, e = qt(l, l.pendingProps), t.child = e, e.return = t; l.sibling !== null; )
        l = l.sibling, e = e.sibling = qt(l, l.pendingProps), e.return = t;
      e.sibling = null;
    }
    return t.child;
  }
  function Oc(l, t) {
    return (l.lanes & t) !== 0 ? !0 : (l = l.dependencies, !!(l !== null && Pu(l)));
  }
  function yh(l, t, e) {
    switch (t.tag) {
      case 3:
        Zl(t, t.stateNode.containerInfo), ie(t, Ol, l.memoizedState.cache), He();
        break;
      case 27:
      case 5:
        Ca(t);
        break;
      case 4:
        Zl(t, t.stateNode.containerInfo);
        break;
      case 10:
        ie(
          t,
          t.type,
          t.memoizedProps.value
        );
        break;
      case 31:
        if (t.memoizedState !== null)
          return t.flags |= 128, Pi(t), null;
        break;
      case 13:
        var a = t.memoizedState;
        if (a !== null)
          return a.dehydrated !== null ? (oe(t), t.flags |= 128, null) : (e & t.child.childLanes) !== 0 ? Fo(l, t, e) : (oe(t), l = Xt(
            l,
            t,
            e
          ), l !== null ? l.sibling : null);
        oe(t);
        break;
      case 19:
        var u = (l.flags & 128) !== 0;
        if (a = (e & t.childLanes) !== 0, a || (da(
          l,
          t,
          e,
          !1
        ), a = (e & t.childLanes) !== 0), u) {
          if (a)
            return Po(
              l,
              t,
              e
            );
          t.flags |= 128;
        }
        if (u = t.memoizedState, u !== null && (u.rendering = null, u.tail = null, u.lastEffect = null), R(Tl, Tl.current), a) break;
        return null;
      case 22:
        return t.lanes = 0, Ko(
          l,
          t,
          e,
          t.pendingProps
        );
      case 24:
        ie(t, Ol, l.memoizedState.cache);
    }
    return Xt(l, t, e);
  }
  function ld(l, t, e) {
    if (l !== null)
      if (l.memoizedProps !== t.pendingProps)
        Ml = !0;
      else {
        if (!Oc(l, e) && (t.flags & 128) === 0)
          return Ml = !1, yh(
            l,
            t,
            e
          );
        Ml = (l.flags & 131072) !== 0;
      }
    else
      Ml = !1, el && (t.flags & 1048576) !== 0 && Ds(t, Wa, t.index);
    switch (t.lanes = 0, t.tag) {
      case 16:
        l: {
          var a = t.pendingProps;
          if (l = Ge(t.elementType), t.type = l, typeof l == "function")
            Ri(l) ? (a = Ze(l, a), t.tag = 1, t = Wo(
              null,
              t,
              l,
              a,
              e
            )) : (t.tag = 0, t = Ac(
              null,
              t,
              l,
              a,
              e
            ));
          else {
            if (l != null) {
              var u = l.$$typeof;
              if (u === Kl) {
                t.tag = 11, t = Xo(
                  null,
                  t,
                  l,
                  a,
                  e
                );
                break l;
              } else if (u === w) {
                t.tag = 14, t = Zo(
                  null,
                  t,
                  l,
                  a,
                  e
                );
                break l;
              }
            }
            throw t = Ut(l) || l, Error(m(306, t, ""));
          }
        }
        return t;
      case 0:
        return Ac(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 1:
        return a = t.type, u = Ze(
          a,
          t.pendingProps
        ), Wo(
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
          ), l === null) throw Error(m(387));
          a = t.pendingProps;
          var n = t.memoizedState;
          u = n.element, $i(l, t), au(t, a, null, e);
          var i = t.memoizedState;
          if (a = i.cache, ie(t, Ol, a), a !== n.cache && Xi(
            t,
            [Ol],
            e,
            !0
          ), eu(), a = i.element, n.isDehydrated)
            if (n = {
              element: a,
              isDehydrated: !1,
              cache: i.cache
            }, t.updateQueue.baseState = n, t.memoizedState = n, t.flags & 256) {
              t = ko(
                l,
                t,
                a,
                e
              );
              break l;
            } else if (a !== u) {
              u = vt(
                Error(m(424)),
                t
              ), ka(u), t = ko(
                l,
                t,
                a,
                e
              );
              break l;
            } else
              for (l = t.stateNode.containerInfo, l.nodeType === 9 ? l = l.body : l = l.nodeName === "HTML" ? l.ownerDocument.body : l, vl = At(l.firstChild), Yl = t, el = !0, ue = null, St = !0, e = Vs(
                t,
                null,
                a,
                e
              ), t.child = e; e; )
                e.flags = e.flags & -3 | 4096, e = e.sibling;
          else {
            if (He(), a === u) {
              t = Xt(
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
        return Sn(l, t), l === null ? (e = dr(
          t.type,
          null,
          t.pendingProps,
          null
        )) ? t.memoizedState = e : el || (e = t.type, l = t.pendingProps, a = qn(
          k.current
        ).createElement(e), a[Bl] = t, a[$l] = l, Ql(a, e, l), Hl(a), t.stateNode = a) : t.memoizedState = dr(
          t.type,
          l.memoizedProps,
          t.pendingProps,
          l.memoizedState
        ), null;
      case 27:
        return Ca(t), l === null && el && (a = t.stateNode = fr(
          t.type,
          t.pendingProps,
          k.current
        ), Yl = t, St = !0, u = vl, Se(t.type) ? (ff = u, vl = At(a.firstChild)) : vl = u), Ll(
          l,
          t,
          t.pendingProps.children,
          e
        ), Sn(l, t), l === null && (t.flags |= 4194304), t.child;
      case 5:
        return l === null && el && ((u = a = vl) && (a = Kh(
          a,
          t.type,
          t.pendingProps,
          St
        ), a !== null ? (t.stateNode = a, Yl = t, vl = At(a.firstChild), St = !1, u = !0) : u = !1), u || ne(t)), Ca(t), u = t.type, n = t.pendingProps, i = l !== null ? l.memoizedProps : null, a = n.children, ef(u, n) ? a = null : i !== null && ef(u, i) && (t.flags |= 32), t.memoizedState !== null && (u = tc(
          l,
          t,
          ih,
          null,
          null,
          e
        ), Tu._currentValue = u), Sn(l, t), Ll(l, t, a, e), t.child;
      case 6:
        return l === null && el && ((l = e = vl) && (e = Jh(
          e,
          t.pendingProps,
          St
        ), e !== null ? (t.stateNode = e, Yl = t, vl = null, l = !0) : l = !1), l || ne(t)), null;
      case 13:
        return Fo(l, t, e);
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
        return Xo(
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
        return a = t.pendingProps, ie(t, t.type, a.value), Ll(l, t, a.children, e), t.child;
      case 9:
        return u = t.type._context, a = t.pendingProps.children, Be(t), u = Gl(u), a = a(u), t.flags |= 1, Ll(l, t, a, e), t.child;
      case 14:
        return Zo(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 15:
        return Vo(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 19:
        return Po(l, t, e);
      case 31:
        return hh(l, t, e);
      case 22:
        return Ko(
          l,
          t,
          e,
          t.pendingProps
        );
      case 24:
        return Be(t), a = Gl(Ol), l === null ? (u = Ki(), u === null && (u = yl, n = Zi(), u.pooledCache = n, n.refCount++, n !== null && (u.pooledCacheLanes |= e), u = n), t.memoizedState = { parent: a, cache: u }, wi(t), ie(t, Ol, u)) : ((l.lanes & e) !== 0 && ($i(l, t), au(t, null, null, e), eu()), u = l.memoizedState, n = t.memoizedState, u.parent !== a ? (u = { parent: a, cache: a }, t.memoizedState = u, t.lanes === 0 && (t.memoizedState = t.updateQueue.baseState = u), ie(t, Ol, a)) : (a = n.cache, ie(t, Ol, a), a !== u.cache && Xi(
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
    throw Error(m(156, t.tag));
  }
  function Zt(l) {
    l.flags |= 4;
  }
  function _c(l, t, e, a, u) {
    if ((t = (l.mode & 32) !== 0) && (t = !1), t) {
      if (l.flags |= 16777216, (u & 335544128) === u)
        if (l.stateNode.complete) l.flags |= 8192;
        else if (Nd()) l.flags |= 8192;
        else
          throw Le = an, Ji;
    } else l.flags &= -16777217;
  }
  function td(l, t) {
    if (t.type !== "stylesheet" || (t.state.loading & 4) !== 0)
      l.flags &= -16777217;
    else if (l.flags |= 16777216, !vr(t))
      if (Nd()) l.flags |= 8192;
      else
        throw Le = an, Ji;
  }
  function An(l, t) {
    t !== null && (l.flags |= 4), l.flags & 16384 && (t = l.tag !== 22 ? Rf() : 536870912, l.lanes |= t, Ta |= t);
  }
  function su(l, t) {
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
  function vh(l, t, e) {
    var a = t.pendingProps;
    switch (Bi(t), t.tag) {
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
        return e = t.stateNode, a = null, l !== null && (a = l.memoizedState.cache), t.memoizedState.cache !== a && (t.flags |= 2048), Gt(Ol), zl(), e.pendingContext && (e.context = e.pendingContext, e.pendingContext = null), (l === null || l.child === null) && (oa(t) ? Zt(t) : l === null || l.memoizedState.isDehydrated && (t.flags & 256) === 0 || (t.flags |= 1024, Gi())), gl(t), null;
      case 26:
        var u = t.type, n = t.memoizedState;
        return l === null ? (Zt(t), n !== null ? (gl(t), td(t, n)) : (gl(t), _c(
          t,
          u,
          null,
          a,
          e
        ))) : n ? n !== l.memoizedState ? (Zt(t), gl(t), td(t, n)) : (gl(t), t.flags &= -16777217) : (l = l.memoizedProps, l !== a && Zt(t), gl(t), _c(
          t,
          u,
          l,
          a,
          e
        )), null;
      case 27:
        if (Du(t), e = k.current, u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Zt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(m(166));
            return gl(t), null;
          }
          l = B.current, oa(t) ? Rs(t) : (l = fr(u, a, e), t.stateNode = l, Zt(t));
        }
        return gl(t), null;
      case 5:
        if (Du(t), u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Zt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(m(166));
            return gl(t), null;
          }
          if (n = B.current, oa(t))
            Rs(t);
          else {
            var i = qn(
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
            n[Bl] = t, n[$l] = a;
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
            l: switch (Ql(n, u, a), u) {
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
            a && Zt(t);
          }
        }
        return gl(t), _c(
          t,
          t.type,
          l === null ? null : l.memoizedProps,
          t.pendingProps,
          e
        ), null;
      case 6:
        if (l && t.stateNode != null)
          l.memoizedProps !== a && Zt(t);
        else {
          if (typeof a != "string" && t.stateNode === null)
            throw Error(m(166));
          if (l = k.current, oa(t)) {
            if (l = t.stateNode, e = t.memoizedProps, a = null, u = Yl, u !== null)
              switch (u.tag) {
                case 27:
                case 5:
                  a = u.memoizedProps;
              }
            l[Bl] = t, l = !!(l.nodeValue === e || a !== null && a.suppressHydrationWarning === !0 || Fd(l.nodeValue, e)), l || ne(t, !0);
          } else
            l = qn(l).createTextNode(
              a
            ), l[Bl] = t, t.stateNode = l;
        }
        return gl(t), null;
      case 31:
        if (e = t.memoizedState, l === null || l.memoizedState !== null) {
          if (a = oa(t), e !== null) {
            if (l === null) {
              if (!a) throw Error(m(318));
              if (l = t.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(m(557));
              l[Bl] = t;
            } else
              He(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            gl(t), l = !1;
          } else
            e = Gi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = e), l = !0;
          if (!l)
            return t.flags & 256 ? (ct(t), t) : (ct(t), null);
          if ((t.flags & 128) !== 0)
            throw Error(m(558));
        }
        return gl(t), null;
      case 13:
        if (a = t.memoizedState, l === null || l.memoizedState !== null && l.memoizedState.dehydrated !== null) {
          if (u = oa(t), a !== null && a.dehydrated !== null) {
            if (l === null) {
              if (!u) throw Error(m(318));
              if (u = t.memoizedState, u = u !== null ? u.dehydrated : null, !u) throw Error(m(317));
              u[Bl] = t;
            } else
              He(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            gl(t), u = !1;
          } else
            u = Gi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = u), u = !0;
          if (!u)
            return t.flags & 256 ? (ct(t), t) : (ct(t), null);
        }
        return ct(t), (t.flags & 128) !== 0 ? (t.lanes = e, t) : (e = a !== null, l = l !== null && l.memoizedState !== null, e && (a = t.child, u = null, a.alternate !== null && a.alternate.memoizedState !== null && a.alternate.memoizedState.cachePool !== null && (u = a.alternate.memoizedState.cachePool.pool), n = null, a.memoizedState !== null && a.memoizedState.cachePool !== null && (n = a.memoizedState.cachePool.pool), n !== u && (a.flags |= 2048)), e !== l && e && (t.child.flags |= 8192), An(t, t.updateQueue), gl(t), null);
      case 4:
        return zl(), l === null && Fc(t.stateNode.containerInfo), gl(t), null;
      case 10:
        return Gt(t.type), gl(t), null;
      case 19:
        if (x(Tl), a = t.memoizedState, a === null) return gl(t), null;
        if (u = (t.flags & 128) !== 0, n = a.rendering, n === null)
          if (u) su(a, !1);
          else {
            if (Al !== 0 || l !== null && (l.flags & 128) !== 0)
              for (l = t.child; l !== null; ) {
                if (n = fn(l), n !== null) {
                  for (t.flags |= 128, su(a, !1), l = n.updateQueue, t.updateQueue = l, An(t, l), t.subtreeFlags = 0, l = e, e = t.child; e !== null; )
                    Os(e, l), e = e.sibling;
                  return R(
                    Tl,
                    Tl.current & 1 | 2
                  ), el && Bt(t, a.treeForkCount), t.child;
                }
                l = l.sibling;
              }
            a.tail !== null && tt() > xn && (t.flags |= 128, u = !0, su(a, !1), t.lanes = 4194304);
          }
        else {
          if (!u)
            if (l = fn(n), l !== null) {
              if (t.flags |= 128, u = !0, l = l.updateQueue, t.updateQueue = l, An(t, l), su(a, !0), a.tail === null && a.tailMode === "hidden" && !n.alternate && !el)
                return gl(t), null;
            } else
              2 * tt() - a.renderingStartTime > xn && e !== 536870912 && (t.flags |= 128, u = !0, su(a, !1), t.lanes = 4194304);
          a.isBackwards ? (n.sibling = t.child, t.child = n) : (l = a.last, l !== null ? l.sibling = n : t.child = n, a.last = n);
        }
        return a.tail !== null ? (l = a.tail, a.rendering = l, a.tail = l.sibling, a.renderingStartTime = tt(), l.sibling = null, e = Tl.current, R(
          Tl,
          u ? e & 1 | 2 : e & 1
        ), el && Bt(t, a.treeForkCount), l) : (gl(t), null);
      case 22:
      case 23:
        return ct(t), Ii(), a = t.memoizedState !== null, l !== null ? l.memoizedState !== null !== a && (t.flags |= 8192) : a && (t.flags |= 8192), a ? (e & 536870912) !== 0 && (t.flags & 128) === 0 && (gl(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : gl(t), e = t.updateQueue, e !== null && An(t, e.retryQueue), e = null, l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (e = l.memoizedState.cachePool.pool), a = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (a = t.memoizedState.cachePool.pool), a !== e && (t.flags |= 2048), l !== null && x(Ye), null;
      case 24:
        return e = null, l !== null && (e = l.memoizedState.cache), t.memoizedState.cache !== e && (t.flags |= 2048), Gt(Ol), gl(t), null;
      case 25:
        return null;
      case 30:
        return null;
    }
    throw Error(m(156, t.tag));
  }
  function gh(l, t) {
    switch (Bi(t), t.tag) {
      case 1:
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 3:
        return Gt(Ol), zl(), l = t.flags, (l & 65536) !== 0 && (l & 128) === 0 ? (t.flags = l & -65537 | 128, t) : null;
      case 26:
      case 27:
      case 5:
        return Du(t), null;
      case 31:
        if (t.memoizedState !== null) {
          if (ct(t), t.alternate === null)
            throw Error(m(340));
          He();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 13:
        if (ct(t), l = t.memoizedState, l !== null && l.dehydrated !== null) {
          if (t.alternate === null)
            throw Error(m(340));
          He();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 19:
        return x(Tl), null;
      case 4:
        return zl(), null;
      case 10:
        return Gt(t.type), null;
      case 22:
      case 23:
        return ct(t), Ii(), l !== null && x(Ye), l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 24:
        return Gt(Ol), null;
      case 25:
        return null;
      default:
        return null;
    }
  }
  function ed(l, t) {
    switch (Bi(t), t.tag) {
      case 3:
        Gt(Ol), zl();
        break;
      case 26:
      case 27:
      case 5:
        Du(t);
        break;
      case 4:
        zl();
        break;
      case 31:
        t.memoizedState !== null && ct(t);
        break;
      case 13:
        ct(t);
        break;
      case 19:
        x(Tl);
        break;
      case 10:
        Gt(t.type);
        break;
      case 22:
      case 23:
        ct(t), Ii(), l !== null && x(Ye);
        break;
      case 24:
        Gt(Ol);
    }
  }
  function ou(l, t) {
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
  function re(l, t, e) {
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
              var s = e, v = c;
              try {
                v();
              } catch (p) {
                sl(
                  u,
                  s,
                  p
                );
              }
            }
          }
          a = a.next;
        } while (a !== n);
      }
    } catch (p) {
      sl(t, t.return, p);
    }
  }
  function ad(l) {
    var t = l.updateQueue;
    if (t !== null) {
      var e = l.stateNode;
      try {
        Js(t, e);
      } catch (a) {
        sl(l, l.return, a);
      }
    }
  }
  function ud(l, t, e) {
    e.props = Ze(
      l.type,
      l.memoizedProps
    ), e.state = l.memoizedState;
    try {
      e.componentWillUnmount();
    } catch (a) {
      sl(l, t, a);
    }
  }
  function du(l, t) {
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
  function Mt(l, t) {
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
  function nd(l) {
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
  function Mc(l, t, e) {
    try {
      var a = l.stateNode;
      Gh(a, l.type, e, t), a[$l] = t;
    } catch (u) {
      sl(l, l.return, u);
    }
  }
  function id(l) {
    return l.tag === 5 || l.tag === 3 || l.tag === 26 || l.tag === 27 && Se(l.type) || l.tag === 4;
  }
  function Dc(l) {
    l: for (; ; ) {
      for (; l.sibling === null; ) {
        if (l.return === null || id(l.return)) return null;
        l = l.return;
      }
      for (l.sibling.return = l.return, l = l.sibling; l.tag !== 5 && l.tag !== 6 && l.tag !== 18; ) {
        if (l.tag === 27 && Se(l.type) || l.flags & 2 || l.child === null || l.tag === 4) continue l;
        l.child.return = l, l = l.child;
      }
      if (!(l.flags & 2)) return l.stateNode;
    }
  }
  function Uc(l, t, e) {
    var a = l.tag;
    if (a === 5 || a === 6)
      l = l.stateNode, t ? (e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e).insertBefore(l, t) : (t = e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e, t.appendChild(l), e = e._reactRootContainer, e != null || t.onclick !== null || (t.onclick = Ct));
    else if (a !== 4 && (a === 27 && Se(l.type) && (e = l.stateNode, t = null), l = l.child, l !== null))
      for (Uc(l, t, e), l = l.sibling; l !== null; )
        Uc(l, t, e), l = l.sibling;
  }
  function zn(l, t, e) {
    var a = l.tag;
    if (a === 5 || a === 6)
      l = l.stateNode, t ? e.insertBefore(l, t) : e.appendChild(l);
    else if (a !== 4 && (a === 27 && Se(l.type) && (e = l.stateNode), l = l.child, l !== null))
      for (zn(l, t, e), l = l.sibling; l !== null; )
        zn(l, t, e), l = l.sibling;
  }
  function cd(l) {
    var t = l.stateNode, e = l.memoizedProps;
    try {
      for (var a = l.type, u = t.attributes; u.length; )
        t.removeAttributeNode(u[0]);
      Ql(t, a, e), t[Bl] = l, t[$l] = e;
    } catch (n) {
      sl(l, l.return, n);
    }
  }
  var Vt = !1, Dl = !1, Rc = !1, fd = typeof WeakSet == "function" ? WeakSet : Set, ql = null;
  function bh(l, t) {
    if (l = l.containerInfo, lf = Zn, l = Ss(l), xi(l)) {
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
            var i = 0, c = -1, s = -1, v = 0, p = 0, j = l, g = null;
            t: for (; ; ) {
              for (var b; j !== e || u !== 0 && j.nodeType !== 3 || (c = i + u), j !== n || a !== 0 && j.nodeType !== 3 || (s = i + a), j.nodeType === 3 && (i += j.nodeValue.length), (b = j.firstChild) !== null; )
                g = j, j = b;
              for (; ; ) {
                if (j === l) break t;
                if (g === e && ++v === u && (c = i), g === n && ++p === a && (s = i), (b = j.nextSibling) !== null) break;
                j = g, g = j.parentNode;
              }
              j = b;
            }
            e = c === -1 || s === -1 ? null : { start: c, end: s };
          } else e = null;
        }
      e = e || { start: 0, end: 0 };
    } else e = null;
    for (tf = { focusedElem: l, selectionRange: e }, Zn = !1, ql = t; ql !== null; )
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
                  var H = Ze(
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
                  uf(l);
                else if (e === 1)
                  switch (l.nodeName) {
                    case "HEAD":
                    case "HTML":
                    case "BODY":
                      uf(l);
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
              if ((l & 1024) !== 0) throw Error(m(163));
          }
          if (l = t.sibling, l !== null) {
            l.return = t.return, ql = l;
            break;
          }
          ql = t.return;
        }
  }
  function sd(l, t, e) {
    var a = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 15:
        Jt(l, e), a & 4 && ou(5, e);
        break;
      case 1:
        if (Jt(l, e), a & 4)
          if (l = e.stateNode, t === null)
            try {
              l.componentDidMount();
            } catch (i) {
              sl(e, e.return, i);
            }
          else {
            var u = Ze(
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
        a & 64 && ad(e), a & 512 && du(e, e.return);
        break;
      case 3:
        if (Jt(l, e), a & 64 && (l = e.updateQueue, l !== null)) {
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
            Js(l, t);
          } catch (i) {
            sl(e, e.return, i);
          }
        }
        break;
      case 27:
        t === null && a & 4 && cd(e);
      case 26:
      case 5:
        Jt(l, e), t === null && a & 4 && nd(e), a & 512 && du(e, e.return);
        break;
      case 12:
        Jt(l, e);
        break;
      case 31:
        Jt(l, e), a & 4 && rd(l, e);
        break;
      case 13:
        Jt(l, e), a & 4 && md(l, e), a & 64 && (l = e.memoizedState, l !== null && (l = l.dehydrated, l !== null && (e = Nh.bind(
          null,
          e
        ), wh(l, e))));
        break;
      case 22:
        if (a = e.memoizedState !== null || Vt, !a) {
          t = t !== null && t.memoizedState !== null || Dl, u = Vt;
          var n = Dl;
          Vt = a, (Dl = t) && !n ? wt(
            l,
            e,
            (e.subtreeFlags & 8772) !== 0
          ) : Jt(l, e), Vt = u, Dl = n;
        }
        break;
      case 30:
        break;
      default:
        Jt(l, e);
    }
  }
  function od(l) {
    var t = l.alternate;
    t !== null && (l.alternate = null, od(t)), l.child = null, l.deletions = null, l.sibling = null, l.tag === 5 && (t = l.stateNode, t !== null && si(t)), l.stateNode = null, l.return = null, l.dependencies = null, l.memoizedProps = null, l.memoizedState = null, l.pendingProps = null, l.stateNode = null, l.updateQueue = null;
  }
  var Sl = null, kl = !1;
  function Kt(l, t, e) {
    for (e = e.child; e !== null; )
      dd(l, t, e), e = e.sibling;
  }
  function dd(l, t, e) {
    if (et && typeof et.onCommitFiberUnmount == "function")
      try {
        et.onCommitFiberUnmount(Ha, e);
      } catch {
      }
    switch (e.tag) {
      case 26:
        Dl || Mt(e, t), Kt(
          l,
          t,
          e
        ), e.memoizedState ? e.memoizedState.count-- : e.stateNode && (e = e.stateNode, e.parentNode.removeChild(e));
        break;
      case 27:
        Dl || Mt(e, t);
        var a = Sl, u = kl;
        Se(e.type) && (Sl = e.stateNode, kl = !1), Kt(
          l,
          t,
          e
        ), pu(e.stateNode), Sl = a, kl = u;
        break;
      case 5:
        Dl || Mt(e, t);
      case 6:
        if (a = Sl, u = kl, Sl = null, Kt(
          l,
          t,
          e
        ), Sl = a, kl = u, Sl !== null)
          if (kl)
            try {
              (Sl.nodeType === 9 ? Sl.body : Sl.nodeName === "HTML" ? Sl.ownerDocument.body : Sl).removeChild(e.stateNode);
            } catch (n) {
              sl(
                e,
                t,
                n
              );
            }
          else
            try {
              Sl.removeChild(e.stateNode);
            } catch (n) {
              sl(
                e,
                t,
                n
              );
            }
        break;
      case 18:
        Sl !== null && (kl ? (l = Sl, ar(
          l.nodeType === 9 ? l.body : l.nodeName === "HTML" ? l.ownerDocument.body : l,
          e.stateNode
        ), Da(l)) : ar(Sl, e.stateNode));
        break;
      case 4:
        a = Sl, u = kl, Sl = e.stateNode.containerInfo, kl = !0, Kt(
          l,
          t,
          e
        ), Sl = a, kl = u;
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        re(2, e, t), Dl || re(4, e, t), Kt(
          l,
          t,
          e
        );
        break;
      case 1:
        Dl || (Mt(e, t), a = e.stateNode, typeof a.componentWillUnmount == "function" && ud(
          e,
          t,
          a
        )), Kt(
          l,
          t,
          e
        );
        break;
      case 21:
        Kt(
          l,
          t,
          e
        );
        break;
      case 22:
        Dl = (a = Dl) || e.memoizedState !== null, Kt(
          l,
          t,
          e
        ), Dl = a;
        break;
      default:
        Kt(
          l,
          t,
          e
        );
    }
  }
  function rd(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null))) {
      l = l.dehydrated;
      try {
        Da(l);
      } catch (e) {
        sl(t, t.return, e);
      }
    }
  }
  function md(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null && (l = l.dehydrated, l !== null))))
      try {
        Da(l);
      } catch (e) {
        sl(t, t.return, e);
      }
  }
  function Sh(l) {
    switch (l.tag) {
      case 31:
      case 13:
      case 19:
        var t = l.stateNode;
        return t === null && (t = l.stateNode = new fd()), t;
      case 22:
        return l = l.stateNode, t = l._retryCache, t === null && (t = l._retryCache = new fd()), t;
      default:
        throw Error(m(435, l.tag));
    }
  }
  function Tn(l, t) {
    var e = Sh(l);
    t.forEach(function(a) {
      if (!e.has(a)) {
        e.add(a);
        var u = Oh.bind(null, l, a);
        a.then(u, u);
      }
    });
  }
  function Fl(l, t) {
    var e = t.deletions;
    if (e !== null)
      for (var a = 0; a < e.length; a++) {
        var u = e[a], n = l, i = t, c = i;
        l: for (; c !== null; ) {
          switch (c.tag) {
            case 27:
              if (Se(c.type)) {
                Sl = c.stateNode, kl = !1;
                break l;
              }
              break;
            case 5:
              Sl = c.stateNode, kl = !1;
              break l;
            case 3:
            case 4:
              Sl = c.stateNode.containerInfo, kl = !0;
              break l;
          }
          c = c.return;
        }
        if (Sl === null) throw Error(m(160));
        dd(n, i, u), Sl = null, kl = !1, n = u.alternate, n !== null && (n.return = null), u.return = null;
      }
    if (t.subtreeFlags & 13886)
      for (t = t.child; t !== null; )
        hd(t, l), t = t.sibling;
  }
  var Et = null;
  function hd(l, t) {
    var e = l.alternate, a = l.flags;
    switch (l.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        Fl(t, l), Il(l), a & 4 && (re(3, l, l.return), ou(3, l), re(5, l, l.return));
        break;
      case 1:
        Fl(t, l), Il(l), a & 512 && (Dl || e === null || Mt(e, e.return)), a & 64 && Vt && (l = l.updateQueue, l !== null && (a = l.callbacks, a !== null && (e = l.shared.hiddenCallbacks, l.shared.hiddenCallbacks = e === null ? a : e.concat(a))));
        break;
      case 26:
        var u = Et;
        if (Fl(t, l), Il(l), a & 512 && (Dl || e === null || Mt(e, e.return)), a & 4) {
          var n = e !== null ? e.memoizedState : null;
          if (a = l.memoizedState, e === null)
            if (a === null)
              if (l.stateNode === null) {
                l: {
                  a = l.type, e = l.memoizedProps, u = u.ownerDocument || u;
                  t: switch (a) {
                    case "title":
                      n = u.getElementsByTagName("title")[0], (!n || n[Ya] || n[Bl] || n.namespaceURI === "http://www.w3.org/2000/svg" || n.hasAttribute("itemprop")) && (n = u.createElement(a), u.head.insertBefore(
                        n,
                        u.querySelector("head > title")
                      )), Ql(n, a, e), n[Bl] = l, Hl(n), a = n;
                      break l;
                    case "link":
                      var i = hr(
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
                      n = u.createElement(a), Ql(n, a, e), u.head.appendChild(n);
                      break;
                    case "meta":
                      if (i = hr(
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
                      n = u.createElement(a), Ql(n, a, e), u.head.appendChild(n);
                      break;
                    default:
                      throw Error(m(468, a));
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
              l.stateNode = mr(
                u,
                a,
                l.memoizedProps
              );
          else
            n !== a ? (n === null ? e.stateNode !== null && (e = e.stateNode, e.parentNode.removeChild(e)) : n.count--, a === null ? yr(
              u,
              l.type,
              l.stateNode
            ) : mr(
              u,
              a,
              l.memoizedProps
            )) : a === null && l.stateNode !== null && Mc(
              l,
              l.memoizedProps,
              e.memoizedProps
            );
        }
        break;
      case 27:
        Fl(t, l), Il(l), a & 512 && (Dl || e === null || Mt(e, e.return)), e !== null && a & 4 && Mc(
          l,
          l.memoizedProps,
          e.memoizedProps
        );
        break;
      case 5:
        if (Fl(t, l), Il(l), a & 512 && (Dl || e === null || Mt(e, e.return)), l.flags & 32) {
          u = l.stateNode;
          try {
            la(u, "");
          } catch (H) {
            sl(l, l.return, H);
          }
        }
        a & 4 && l.stateNode != null && (u = l.memoizedProps, Mc(
          l,
          u,
          e !== null ? e.memoizedProps : u
        )), a & 1024 && (Rc = !0);
        break;
      case 6:
        if (Fl(t, l), Il(l), a & 4) {
          if (l.stateNode === null)
            throw Error(m(162));
          a = l.memoizedProps, e = l.stateNode;
          try {
            e.nodeValue = a;
          } catch (H) {
            sl(l, l.return, H);
          }
        }
        break;
      case 3:
        if (Gn = null, u = Et, Et = Bn(t.containerInfo), Fl(t, l), Et = u, Il(l), a & 4 && e !== null && e.memoizedState.isDehydrated)
          try {
            Da(t.containerInfo);
          } catch (H) {
            sl(l, l.return, H);
          }
        Rc && (Rc = !1, yd(l));
        break;
      case 4:
        a = Et, Et = Bn(
          l.stateNode.containerInfo
        ), Fl(t, l), Il(l), Et = a;
        break;
      case 12:
        Fl(t, l), Il(l);
        break;
      case 31:
        Fl(t, l), Il(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
        break;
      case 13:
        Fl(t, l), Il(l), l.child.flags & 8192 && l.memoizedState !== null != (e !== null && e.memoizedState !== null) && (En = tt()), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
        break;
      case 22:
        u = l.memoizedState !== null;
        var s = e !== null && e.memoizedState !== null, v = Vt, p = Dl;
        if (Vt = v || u, Dl = p || s, Fl(t, l), Dl = p, Vt = v, Il(l), a & 8192)
          l: for (t = l.stateNode, t._visibility = u ? t._visibility & -2 : t._visibility | 1, u && (e === null || s || Vt || Dl || Ve(l)), e = null, t = l; ; ) {
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
                  var b = s.stateNode;
                  u ? ur(b, !0) : ur(s.stateNode, !1);
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
        a & 4 && (a = l.updateQueue, a !== null && (e = a.retryQueue, e !== null && (a.retryQueue = null, Tn(l, e))));
        break;
      case 19:
        Fl(t, l), Il(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
        break;
      case 30:
        break;
      case 21:
        break;
      default:
        Fl(t, l), Il(l);
    }
  }
  function Il(l) {
    var t = l.flags;
    if (t & 2) {
      try {
        for (var e, a = l.return; a !== null; ) {
          if (id(a)) {
            e = a;
            break;
          }
          a = a.return;
        }
        if (e == null) throw Error(m(160));
        switch (e.tag) {
          case 27:
            var u = e.stateNode, n = Dc(l);
            zn(l, n, u);
            break;
          case 5:
            var i = e.stateNode;
            e.flags & 32 && (la(i, ""), e.flags &= -33);
            var c = Dc(l);
            zn(l, c, i);
            break;
          case 3:
          case 4:
            var s = e.stateNode.containerInfo, v = Dc(l);
            Uc(
              l,
              v,
              s
            );
            break;
          default:
            throw Error(m(161));
        }
      } catch (p) {
        sl(l, l.return, p);
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
  function Jt(l, t) {
    if (t.subtreeFlags & 8772)
      for (t = t.child; t !== null; )
        sd(l, t.alternate, t), t = t.sibling;
  }
  function Ve(l) {
    for (l = l.child; l !== null; ) {
      var t = l;
      switch (t.tag) {
        case 0:
        case 11:
        case 14:
        case 15:
          re(4, t, t.return), Ve(t);
          break;
        case 1:
          Mt(t, t.return);
          var e = t.stateNode;
          typeof e.componentWillUnmount == "function" && ud(
            t,
            t.return,
            e
          ), Ve(t);
          break;
        case 27:
          pu(t.stateNode);
        case 26:
        case 5:
          Mt(t, t.return), Ve(t);
          break;
        case 22:
          t.memoizedState === null && Ve(t);
          break;
        case 30:
          Ve(t);
          break;
        default:
          Ve(t);
      }
      l = l.sibling;
    }
  }
  function wt(l, t, e) {
    for (e = e && (t.subtreeFlags & 8772) !== 0, t = t.child; t !== null; ) {
      var a = t.alternate, u = l, n = t, i = n.flags;
      switch (n.tag) {
        case 0:
        case 11:
        case 15:
          wt(
            u,
            n,
            e
          ), ou(4, n);
          break;
        case 1:
          if (wt(
            u,
            n,
            e
          ), a = n, u = a.stateNode, typeof u.componentDidMount == "function")
            try {
              u.componentDidMount();
            } catch (v) {
              sl(a, a.return, v);
            }
          if (a = n, u = a.updateQueue, u !== null) {
            var c = a.stateNode;
            try {
              var s = u.shared.hiddenCallbacks;
              if (s !== null)
                for (u.shared.hiddenCallbacks = null, u = 0; u < s.length; u++)
                  Ks(s[u], c);
            } catch (v) {
              sl(a, a.return, v);
            }
          }
          e && i & 64 && ad(n), du(n, n.return);
          break;
        case 27:
          cd(n);
        case 26:
        case 5:
          wt(
            u,
            n,
            e
          ), e && a === null && i & 4 && nd(n), du(n, n.return);
          break;
        case 12:
          wt(
            u,
            n,
            e
          );
          break;
        case 31:
          wt(
            u,
            n,
            e
          ), e && i & 4 && rd(u, n);
          break;
        case 13:
          wt(
            u,
            n,
            e
          ), e && i & 4 && md(u, n);
          break;
        case 22:
          n.memoizedState === null && wt(
            u,
            n,
            e
          ), du(n, n.return);
          break;
        case 30:
          break;
        default:
          wt(
            u,
            n,
            e
          );
      }
      t = t.sibling;
    }
  }
  function Cc(l, t) {
    var e = null;
    l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (e = l.memoizedState.cachePool.pool), l = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (l = t.memoizedState.cachePool.pool), l !== e && (l != null && l.refCount++, e != null && Fa(e));
  }
  function Hc(l, t) {
    l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Fa(l));
  }
  function xt(l, t, e, a) {
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; )
        vd(
          l,
          t,
          e,
          a
        ), t = t.sibling;
  }
  function vd(l, t, e, a) {
    var u = t.flags;
    switch (t.tag) {
      case 0:
      case 11:
      case 15:
        xt(
          l,
          t,
          e,
          a
        ), u & 2048 && ou(9, t);
        break;
      case 1:
        xt(
          l,
          t,
          e,
          a
        );
        break;
      case 3:
        xt(
          l,
          t,
          e,
          a
        ), u & 2048 && (l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Fa(l)));
        break;
      case 12:
        if (u & 2048) {
          xt(
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
          xt(
            l,
            t,
            e,
            a
          );
        break;
      case 31:
        xt(
          l,
          t,
          e,
          a
        );
        break;
      case 13:
        xt(
          l,
          t,
          e,
          a
        );
        break;
      case 23:
        break;
      case 22:
        n = t.stateNode, i = t.alternate, t.memoizedState !== null ? n._visibility & 2 ? xt(
          l,
          t,
          e,
          a
        ) : ru(l, t) : n._visibility & 2 ? xt(
          l,
          t,
          e,
          a
        ) : (n._visibility |= 2, pa(
          l,
          t,
          e,
          a,
          (t.subtreeFlags & 10256) !== 0 || !1
        )), u & 2048 && Cc(i, t);
        break;
      case 24:
        xt(
          l,
          t,
          e,
          a
        ), u & 2048 && Hc(t.alternate, t);
        break;
      default:
        xt(
          l,
          t,
          e,
          a
        );
    }
  }
  function pa(l, t, e, a, u) {
    for (u = u && ((t.subtreeFlags & 10256) !== 0 || !1), t = t.child; t !== null; ) {
      var n = l, i = t, c = e, s = a, v = i.flags;
      switch (i.tag) {
        case 0:
        case 11:
        case 15:
          pa(
            n,
            i,
            c,
            s,
            u
          ), ou(8, i);
          break;
        case 23:
          break;
        case 22:
          var p = i.stateNode;
          i.memoizedState !== null ? p._visibility & 2 ? pa(
            n,
            i,
            c,
            s,
            u
          ) : ru(
            n,
            i
          ) : (p._visibility |= 2, pa(
            n,
            i,
            c,
            s,
            u
          )), u && v & 2048 && Cc(
            i.alternate,
            i
          );
          break;
        case 24:
          pa(
            n,
            i,
            c,
            s,
            u
          ), u && v & 2048 && Hc(i.alternate, i);
          break;
        default:
          pa(
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
  function ru(l, t) {
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; ) {
        var e = l, a = t, u = a.flags;
        switch (a.tag) {
          case 22:
            ru(e, a), u & 2048 && Cc(
              a.alternate,
              a
            );
            break;
          case 24:
            ru(e, a), u & 2048 && Hc(a.alternate, a);
            break;
          default:
            ru(e, a);
        }
        t = t.sibling;
      }
  }
  var mu = 8192;
  function Aa(l, t, e) {
    if (l.subtreeFlags & mu)
      for (l = l.child; l !== null; )
        gd(
          l,
          t,
          e
        ), l = l.sibling;
  }
  function gd(l, t, e) {
    switch (l.tag) {
      case 26:
        Aa(
          l,
          t,
          e
        ), l.flags & mu && l.memoizedState !== null && ny(
          e,
          Et,
          l.memoizedState,
          l.memoizedProps
        );
        break;
      case 5:
        Aa(
          l,
          t,
          e
        );
        break;
      case 3:
      case 4:
        var a = Et;
        Et = Bn(l.stateNode.containerInfo), Aa(
          l,
          t,
          e
        ), Et = a;
        break;
      case 22:
        l.memoizedState === null && (a = l.alternate, a !== null && a.memoizedState !== null ? (a = mu, mu = 16777216, Aa(
          l,
          t,
          e
        ), mu = a) : Aa(
          l,
          t,
          e
        ));
        break;
      default:
        Aa(
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
  function hu(l) {
    var t = l.deletions;
    if ((l.flags & 16) !== 0) {
      if (t !== null)
        for (var e = 0; e < t.length; e++) {
          var a = t[e];
          ql = a, pd(
            a,
            l
          );
        }
      bd(l);
    }
    if (l.subtreeFlags & 10256)
      for (l = l.child; l !== null; )
        Sd(l), l = l.sibling;
  }
  function Sd(l) {
    switch (l.tag) {
      case 0:
      case 11:
      case 15:
        hu(l), l.flags & 2048 && re(9, l, l.return);
        break;
      case 3:
        hu(l);
        break;
      case 12:
        hu(l);
        break;
      case 22:
        var t = l.stateNode;
        l.memoizedState !== null && t._visibility & 2 && (l.return === null || l.return.tag !== 13) ? (t._visibility &= -3, jn(l)) : hu(l);
        break;
      default:
        hu(l);
    }
  }
  function jn(l) {
    var t = l.deletions;
    if ((l.flags & 16) !== 0) {
      if (t !== null)
        for (var e = 0; e < t.length; e++) {
          var a = t[e];
          ql = a, pd(
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
          re(8, t, t.return), jn(t);
          break;
        case 22:
          e = t.stateNode, e._visibility & 2 && (e._visibility &= -3, jn(t));
          break;
        default:
          jn(t);
      }
      l = l.sibling;
    }
  }
  function pd(l, t) {
    for (; ql !== null; ) {
      var e = ql;
      switch (e.tag) {
        case 0:
        case 11:
        case 15:
          re(8, e, t);
          break;
        case 23:
        case 22:
          if (e.memoizedState !== null && e.memoizedState.cachePool !== null) {
            var a = e.memoizedState.cachePool.pool;
            a != null && a.refCount++;
          }
          break;
        case 24:
          Fa(e.memoizedState.cache);
      }
      if (a = e.child, a !== null) a.return = e, ql = a;
      else
        l: for (e = l; ql !== null; ) {
          a = ql;
          var u = a.sibling, n = a.return;
          if (od(a), a === e) {
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
  var ph = {
    getCacheForType: function(l) {
      var t = Gl(Ol), e = t.data.get(l);
      return e === void 0 && (e = l(), t.data.set(l, e)), e;
    },
    cacheSignal: function() {
      return Gl(Ol).controller.signal;
    }
  }, Ah = typeof WeakMap == "function" ? WeakMap : Map, nl = 0, yl = null, F = null, P = 0, fl = 0, ft = null, me = !1, za = !1, qc = !1, $t = 0, Al = 0, he = 0, Ke = 0, Bc = 0, st = 0, Ta = 0, yu = null, Pl = null, Yc = !1, En = 0, Ad = 0, xn = 1 / 0, Nn = null, ye = null, Ul = 0, ve = null, ja = null, Wt = 0, Gc = 0, Lc = null, zd = null, vu = 0, Qc = null;
  function ot() {
    return (nl & 2) !== 0 && P !== 0 ? P & -P : A.T !== null ? wc() : Bf();
  }
  function Td() {
    if (st === 0)
      if ((P & 536870912) === 0 || el) {
        var l = Cu;
        Cu <<= 1, (Cu & 3932160) === 0 && (Cu = 262144), st = l;
      } else st = 536870912;
    return l = it.current, l !== null && (l.flags |= 32), st;
  }
  function lt(l, t, e) {
    (l === yl && (fl === 2 || fl === 9) || l.cancelPendingCommit !== null) && (Ea(l, 0), ge(
      l,
      P,
      st,
      !1
    )), Ba(l, e), ((nl & 2) === 0 || l !== yl) && (l === yl && ((nl & 2) === 0 && (Ke |= e), Al === 4 && ge(
      l,
      P,
      st,
      !1
    )), Dt(l));
  }
  function jd(l, t, e) {
    if ((nl & 6) !== 0) throw Error(m(327));
    var a = !e && (t & 127) === 0 && (t & l.expiredLanes) === 0 || qa(l, t), u = a ? jh(l, t) : Zc(l, t, !0), n = a;
    do {
      if (u === 0) {
        za && !a && ge(l, t, 0, !1);
        break;
      } else {
        if (e = l.current.alternate, n && !zh(e)) {
          u = Zc(l, t, !1), n = !1;
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
              if (s && (Ea(c, i).flags |= 256), i = Zc(
                c,
                i,
                !1
              ), i !== 2) {
                if (qc && !s) {
                  c.errorRecoveryDisabledLanes |= n, Ke |= n, u = 4;
                  break l;
                }
                n = Pl, Pl = u, n !== null && (Pl === null ? Pl = n : Pl.push.apply(
                  Pl,
                  n
                ));
              }
              u = i;
            }
            if (n = !1, u !== 2) continue;
          }
        }
        if (u === 1) {
          Ea(l, 0), ge(l, t, 0, !0);
          break;
        }
        l: {
          switch (a = l, n = u, n) {
            case 0:
            case 1:
              throw Error(m(345));
            case 4:
              if ((t & 4194048) !== t) break;
            case 6:
              ge(
                a,
                t,
                st,
                !me
              );
              break l;
            case 2:
              Pl = null;
              break;
            case 3:
            case 5:
              break;
            default:
              throw Error(m(329));
          }
          if ((t & 62914560) === t && (u = En + 300 - tt(), 10 < u)) {
            if (ge(
              a,
              t,
              st,
              !me
            ), qu(a, 0, !0) !== 0) break l;
            Wt = t, a.timeoutHandle = tr(
              Ed.bind(
                null,
                a,
                e,
                Pl,
                Nn,
                Yc,
                t,
                st,
                Ke,
                Ta,
                me,
                n,
                "Throttled",
                -0,
                0
              ),
              u
            );
            break l;
          }
          Ed(
            a,
            e,
            Pl,
            Nn,
            Yc,
            t,
            st,
            Ke,
            Ta,
            me,
            n,
            null,
            -0,
            0
          );
        }
      }
      break;
    } while (!0);
    Dt(l);
  }
  function Ed(l, t, e, a, u, n, i, c, s, v, p, j, g, b) {
    if (l.timeoutHandle = -1, j = t.subtreeFlags, j & 8192 || (j & 16785408) === 16785408) {
      j = {
        stylesheets: null,
        count: 0,
        imgCount: 0,
        imgBytes: 0,
        suspenseyImages: [],
        waitingForImages: !0,
        waitingForViewTransition: !1,
        unsuspend: Ct
      }, gd(
        t,
        n,
        j
      );
      var H = (n & 62914560) === n ? En - tt() : (n & 4194048) === n ? Ad - tt() : 0;
      if (H = iy(
        j,
        H
      ), H !== null) {
        Wt = n, l.cancelPendingCommit = H(
          Rd.bind(
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
            p,
            j,
            null,
            g,
            b
          )
        ), ge(l, n, i, !v);
        return;
      }
    }
    Rd(
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
  function zh(l) {
    for (var t = l; ; ) {
      var e = t.tag;
      if ((e === 0 || e === 11 || e === 15) && t.flags & 16384 && (e = t.updateQueue, e !== null && (e = e.stores, e !== null)))
        for (var a = 0; a < e.length; a++) {
          var u = e[a], n = u.getSnapshot;
          u = u.value;
          try {
            if (!ut(n(), u)) return !1;
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
  function ge(l, t, e, a) {
    t &= ~Bc, t &= ~Ke, l.suspendedLanes |= t, l.pingedLanes &= ~t, a && (l.warmLanes |= t), a = l.expirationTimes;
    for (var u = t; 0 < u; ) {
      var n = 31 - at(u), i = 1 << n;
      a[n] = -1, u &= ~i;
    }
    e !== 0 && Cf(l, e, t);
  }
  function On() {
    return (nl & 6) === 0 ? (gu(0), !1) : !0;
  }
  function Xc() {
    if (F !== null) {
      if (fl === 0)
        var l = F.return;
      else
        l = F, Yt = qe = null, uc(l), ya = null, Pa = 0, l = F;
      for (; l !== null; )
        ed(l.alternate, l), l = l.return;
      F = null;
    }
  }
  function Ea(l, t) {
    var e = l.timeoutHandle;
    e !== -1 && (l.timeoutHandle = -1, Xh(e)), e = l.cancelPendingCommit, e !== null && (l.cancelPendingCommit = null, e()), Wt = 0, Xc(), yl = l, F = e = qt(l.current, null), P = t, fl = 0, ft = null, me = !1, za = qa(l, t), qc = !1, Ta = st = Bc = Ke = he = Al = 0, Pl = yu = null, Yc = !1, (t & 8) !== 0 && (t |= t & 32);
    var a = l.entangledLanes;
    if (a !== 0)
      for (l = l.entanglements, a &= t; 0 < a; ) {
        var u = 31 - at(a), n = 1 << u;
        t |= l[u], a &= ~n;
      }
    return $t = t, $u(), e;
  }
  function xd(l, t) {
    J = null, A.H = cu, t === ha || t === en ? (t = Qs(), fl = 3) : t === Ji ? (t = Qs(), fl = 4) : fl = t === pc ? 8 : t !== null && typeof t == "object" && typeof t.then == "function" ? 6 : 1, ft = t, F === null && (Al = 1, gn(
      l,
      vt(t, l.current)
    ));
  }
  function Nd() {
    var l = it.current;
    return l === null ? !0 : (P & 4194048) === P ? pt === null : (P & 62914560) === P || (P & 536870912) !== 0 ? l === pt : !1;
  }
  function Od() {
    var l = A.H;
    return A.H = cu, l === null ? cu : l;
  }
  function _d() {
    var l = A.A;
    return A.A = ph, l;
  }
  function _n() {
    Al = 4, me || (P & 4194048) !== P && it.current !== null || (za = !0), (he & 134217727) === 0 && (Ke & 134217727) === 0 || yl === null || ge(
      yl,
      P,
      st,
      !1
    );
  }
  function Zc(l, t, e) {
    var a = nl;
    nl |= 2;
    var u = Od(), n = _d();
    (yl !== l || P !== t) && (Nn = null, Ea(l, t)), t = !1;
    var i = Al;
    l: do
      try {
        if (fl !== 0 && F !== null) {
          var c = F, s = ft;
          switch (fl) {
            case 8:
              Xc(), i = 6;
              break l;
            case 3:
            case 2:
            case 9:
            case 6:
              it.current === null && (t = !0);
              var v = fl;
              if (fl = 0, ft = null, xa(l, c, s, v), e && za) {
                i = 0;
                break l;
              }
              break;
            default:
              v = fl, fl = 0, ft = null, xa(l, c, s, v);
          }
        }
        Th(), i = Al;
        break;
      } catch (p) {
        xd(l, p);
      }
    while (!0);
    return t && l.shellSuspendCounter++, Yt = qe = null, nl = a, A.H = u, A.A = n, F === null && (yl = null, P = 0, $u()), i;
  }
  function Th() {
    for (; F !== null; ) Md(F);
  }
  function jh(l, t) {
    var e = nl;
    nl |= 2;
    var a = Od(), u = _d();
    yl !== l || P !== t ? (Nn = null, xn = tt() + 500, Ea(l, t)) : za = qa(
      l,
      t
    );
    l: do
      try {
        if (fl !== 0 && F !== null) {
          t = F;
          var n = ft;
          t: switch (fl) {
            case 1:
              fl = 0, ft = null, xa(l, t, n, 1);
              break;
            case 2:
            case 9:
              if (Gs(n)) {
                fl = 0, ft = null, Dd(t);
                break;
              }
              t = function() {
                fl !== 2 && fl !== 9 || yl !== l || (fl = 7), Dt(l);
              }, n.then(t, t);
              break l;
            case 3:
              fl = 7;
              break l;
            case 4:
              fl = 5;
              break l;
            case 7:
              Gs(n) ? (fl = 0, ft = null, Dd(t)) : (fl = 0, ft = null, xa(l, t, n, 7));
              break;
            case 5:
              var i = null;
              switch (F.tag) {
                case 26:
                  i = F.memoizedState;
                case 5:
                case 27:
                  var c = F;
                  if (i ? vr(i) : c.stateNode.complete) {
                    fl = 0, ft = null;
                    var s = c.sibling;
                    if (s !== null) F = s;
                    else {
                      var v = c.return;
                      v !== null ? (F = v, Mn(v)) : F = null;
                    }
                    break t;
                  }
              }
              fl = 0, ft = null, xa(l, t, n, 5);
              break;
            case 6:
              fl = 0, ft = null, xa(l, t, n, 6);
              break;
            case 8:
              Xc(), Al = 6;
              break l;
            default:
              throw Error(m(462));
          }
        }
        Eh();
        break;
      } catch (p) {
        xd(l, p);
      }
    while (!0);
    return Yt = qe = null, A.H = a, A.A = u, nl = e, F !== null ? 0 : (yl = null, P = 0, $u(), Al);
  }
  function Eh() {
    for (; F !== null && !$r(); )
      Md(F);
  }
  function Md(l) {
    var t = ld(l.alternate, l, $t);
    l.memoizedProps = l.pendingProps, t === null ? Mn(l) : F = t;
  }
  function Dd(l) {
    var t = l, e = t.alternate;
    switch (t.tag) {
      case 15:
      case 0:
        t = $o(
          e,
          t,
          t.pendingProps,
          t.type,
          void 0,
          P
        );
        break;
      case 11:
        t = $o(
          e,
          t,
          t.pendingProps,
          t.type.render,
          t.ref,
          P
        );
        break;
      case 5:
        uc(t);
      default:
        ed(e, t), t = F = Os(t, $t), t = ld(e, t, $t);
    }
    l.memoizedProps = l.pendingProps, t === null ? Mn(l) : F = t;
  }
  function xa(l, t, e, a) {
    Yt = qe = null, uc(t), ya = null, Pa = 0;
    var u = t.return;
    try {
      if (mh(
        l,
        u,
        t,
        e,
        P
      )) {
        Al = 1, gn(
          l,
          vt(e, l.current)
        ), F = null;
        return;
      }
    } catch (n) {
      if (u !== null) throw F = u, n;
      Al = 1, gn(
        l,
        vt(e, l.current)
      ), F = null;
      return;
    }
    t.flags & 32768 ? (el || a === 1 ? l = !0 : za || (P & 536870912) !== 0 ? l = !1 : (me = l = !0, (a === 2 || a === 9 || a === 3 || a === 6) && (a = it.current, a !== null && a.tag === 13 && (a.flags |= 16384))), Ud(t, l)) : Mn(t);
  }
  function Mn(l) {
    var t = l;
    do {
      if ((t.flags & 32768) !== 0) {
        Ud(
          t,
          me
        );
        return;
      }
      l = t.return;
      var e = vh(
        t.alternate,
        t,
        $t
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
  function Ud(l, t) {
    do {
      var e = gh(l.alternate, l);
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
  function Rd(l, t, e, a, u, n, i, c, s) {
    l.cancelPendingCommit = null;
    do
      Dn();
    while (Ul !== 0);
    if ((nl & 6) !== 0) throw Error(m(327));
    if (t !== null) {
      if (t === l.current) throw Error(m(177));
      if (n = t.lanes | t.childLanes, n |= Di, um(
        l,
        e,
        n,
        i,
        c,
        s
      ), l === yl && (F = yl = null, P = 0), ja = t, ve = l, Wt = e, Gc = n, Lc = u, zd = a, (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? (l.callbackNode = null, l.callbackPriority = 0, _h(Uu, function() {
        return Yd(), null;
      })) : (l.callbackNode = null, l.callbackPriority = 0), a = (t.flags & 13878) !== 0, (t.subtreeFlags & 13878) !== 0 || a) {
        a = A.T, A.T = null, u = U.p, U.p = 2, i = nl, nl |= 4;
        try {
          bh(l, t, e);
        } finally {
          nl = i, U.p = u, A.T = a;
        }
      }
      Ul = 1, Cd(), Hd(), qd();
    }
  }
  function Cd() {
    if (Ul === 1) {
      Ul = 0;
      var l = ve, t = ja, e = (t.flags & 13878) !== 0;
      if ((t.subtreeFlags & 13878) !== 0 || e) {
        e = A.T, A.T = null;
        var a = U.p;
        U.p = 2;
        var u = nl;
        nl |= 4;
        try {
          hd(t, l);
          var n = tf, i = Ss(l.containerInfo), c = n.focusedElem, s = n.selectionRange;
          if (i !== c && c && c.ownerDocument && bs(
            c.ownerDocument.documentElement,
            c
          )) {
            if (s !== null && xi(c)) {
              var v = s.start, p = s.end;
              if (p === void 0 && (p = v), "selectionStart" in c)
                c.selectionStart = v, c.selectionEnd = Math.min(
                  p,
                  c.value.length
                );
              else {
                var j = c.ownerDocument || document, g = j && j.defaultView || window;
                if (g.getSelection) {
                  var b = g.getSelection(), H = c.textContent.length, L = Math.min(s.start, H), ml = s.end === void 0 ? L : Math.min(s.end, H);
                  !b.extend && L > ml && (i = ml, ml = L, L = i);
                  var h = gs(
                    c,
                    L
                  ), d = gs(
                    c,
                    ml
                  );
                  if (h && d && (b.rangeCount !== 1 || b.anchorNode !== h.node || b.anchorOffset !== h.offset || b.focusNode !== d.node || b.focusOffset !== d.offset)) {
                    var y = j.createRange();
                    y.setStart(h.node, h.offset), b.removeAllRanges(), L > ml ? (b.addRange(y), b.extend(d.node, d.offset)) : (y.setEnd(d.node, d.offset), b.addRange(y));
                  }
                }
              }
            }
            for (j = [], b = c; b = b.parentNode; )
              b.nodeType === 1 && j.push({
                element: b,
                left: b.scrollLeft,
                top: b.scrollTop
              });
            for (typeof c.focus == "function" && c.focus(), c = 0; c < j.length; c++) {
              var z = j[c];
              z.element.scrollLeft = z.left, z.element.scrollTop = z.top;
            }
          }
          Zn = !!lf, tf = lf = null;
        } finally {
          nl = u, U.p = a, A.T = e;
        }
      }
      l.current = t, Ul = 2;
    }
  }
  function Hd() {
    if (Ul === 2) {
      Ul = 0;
      var l = ve, t = ja, e = (t.flags & 8772) !== 0;
      if ((t.subtreeFlags & 8772) !== 0 || e) {
        e = A.T, A.T = null;
        var a = U.p;
        U.p = 2;
        var u = nl;
        nl |= 4;
        try {
          sd(l, t.alternate, t);
        } finally {
          nl = u, U.p = a, A.T = e;
        }
      }
      Ul = 3;
    }
  }
  function qd() {
    if (Ul === 4 || Ul === 3) {
      Ul = 0, Wr();
      var l = ve, t = ja, e = Wt, a = zd;
      (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? Ul = 5 : (Ul = 0, ja = ve = null, Bd(l, l.pendingLanes));
      var u = l.pendingLanes;
      if (u === 0 && (ye = null), ci(e), t = t.stateNode, et && typeof et.onCommitFiberRoot == "function")
        try {
          et.onCommitFiberRoot(
            Ha,
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
      (Wt & 3) !== 0 && Dn(), Dt(l), u = l.pendingLanes, (e & 261930) !== 0 && (u & 42) !== 0 ? l === Qc ? vu++ : (vu = 0, Qc = l) : vu = 0, gu(0);
    }
  }
  function Bd(l, t) {
    (l.pooledCacheLanes &= t) === 0 && (t = l.pooledCache, t != null && (l.pooledCache = null, Fa(t)));
  }
  function Dn() {
    return Cd(), Hd(), qd(), Yd();
  }
  function Yd() {
    if (Ul !== 5) return !1;
    var l = ve, t = Gc;
    Gc = 0;
    var e = ci(Wt), a = A.T, u = U.p;
    try {
      U.p = 32 > e ? 32 : e, A.T = null, e = Lc, Lc = null;
      var n = ve, i = Wt;
      if (Ul = 0, ja = ve = null, Wt = 0, (nl & 6) !== 0) throw Error(m(331));
      var c = nl;
      if (nl |= 4, Sd(n.current), vd(
        n,
        n.current,
        i,
        e
      ), nl = c, gu(0, !1), et && typeof et.onPostCommitFiberRoot == "function")
        try {
          et.onPostCommitFiberRoot(Ha, n);
        } catch {
        }
      return !0;
    } finally {
      U.p = u, A.T = a, Bd(l, t);
    }
  }
  function Gd(l, t, e) {
    t = vt(e, t), t = Sc(l.stateNode, t, 2), l = se(l, t, 2), l !== null && (Ba(l, 2), Dt(l));
  }
  function sl(l, t, e) {
    if (l.tag === 3)
      Gd(l, l, e);
    else
      for (; t !== null; ) {
        if (t.tag === 3) {
          Gd(
            t,
            l,
            e
          );
          break;
        } else if (t.tag === 1) {
          var a = t.stateNode;
          if (typeof t.type.getDerivedStateFromError == "function" || typeof a.componentDidCatch == "function" && (ye === null || !ye.has(a))) {
            l = vt(e, l), e = Lo(2), a = se(t, e, 2), a !== null && (Qo(
              e,
              a,
              t,
              l
            ), Ba(a, 2), Dt(a));
            break;
          }
        }
        t = t.return;
      }
  }
  function Vc(l, t, e) {
    var a = l.pingCache;
    if (a === null) {
      a = l.pingCache = new Ah();
      var u = /* @__PURE__ */ new Set();
      a.set(t, u);
    } else
      u = a.get(t), u === void 0 && (u = /* @__PURE__ */ new Set(), a.set(t, u));
    u.has(e) || (qc = !0, u.add(e), l = xh.bind(null, l, t, e), t.then(l, l));
  }
  function xh(l, t, e) {
    var a = l.pingCache;
    a !== null && a.delete(t), l.pingedLanes |= l.suspendedLanes & e, l.warmLanes &= ~e, yl === l && (P & e) === e && (Al === 4 || Al === 3 && (P & 62914560) === P && 300 > tt() - En ? (nl & 2) === 0 && Ea(l, 0) : Bc |= e, Ta === P && (Ta = 0)), Dt(l);
  }
  function Ld(l, t) {
    t === 0 && (t = Rf()), l = Re(l, t), l !== null && (Ba(l, t), Dt(l));
  }
  function Nh(l) {
    var t = l.memoizedState, e = 0;
    t !== null && (e = t.retryLane), Ld(l, e);
  }
  function Oh(l, t) {
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
        throw Error(m(314));
    }
    a !== null && a.delete(t), Ld(l, e);
  }
  function _h(l, t) {
    return ai(l, t);
  }
  var Un = null, Na = null, Kc = !1, Rn = !1, Jc = !1, be = 0;
  function Dt(l) {
    l !== Na && l.next === null && (Na === null ? Un = Na = l : Na = Na.next = l), Rn = !0, Kc || (Kc = !0, Dh());
  }
  function gu(l, t) {
    if (!Jc && Rn) {
      Jc = !0;
      do
        for (var e = !1, a = Un; a !== null; ) {
          if (l !== 0) {
            var u = a.pendingLanes;
            if (u === 0) var n = 0;
            else {
              var i = a.suspendedLanes, c = a.pingedLanes;
              n = (1 << 31 - at(42 | l) + 1) - 1, n &= u & ~(i & ~c), n = n & 201326741 ? n & 201326741 | 1 : n ? n | 2 : 0;
            }
            n !== 0 && (e = !0, Vd(a, n));
          } else
            n = P, n = qu(
              a,
              a === yl ? n : 0,
              a.cancelPendingCommit !== null || a.timeoutHandle !== -1
            ), (n & 3) === 0 || qa(a, n) || (e = !0, Vd(a, n));
          a = a.next;
        }
      while (e);
      Jc = !1;
    }
  }
  function Mh() {
    Qd();
  }
  function Qd() {
    Rn = Kc = !1;
    var l = 0;
    be !== 0 && Qh() && (l = be);
    for (var t = tt(), e = null, a = Un; a !== null; ) {
      var u = a.next, n = Xd(a, t);
      n === 0 ? (a.next = null, e === null ? Un = u : e.next = u, u === null && (Na = e)) : (e = a, (l !== 0 || (n & 3) !== 0) && (Rn = !0)), a = u;
    }
    Ul !== 0 && Ul !== 5 || gu(l), be !== 0 && (be = 0);
  }
  function Xd(l, t) {
    for (var e = l.suspendedLanes, a = l.pingedLanes, u = l.expirationTimes, n = l.pendingLanes & -62914561; 0 < n; ) {
      var i = 31 - at(n), c = 1 << i, s = u[i];
      s === -1 ? ((c & e) === 0 || (c & a) !== 0) && (u[i] = am(c, t)) : s <= t && (l.expiredLanes |= c), n &= ~c;
    }
    if (t = yl, e = P, e = qu(
      l,
      l === t ? e : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), a = l.callbackNode, e === 0 || l === t && (fl === 2 || fl === 9) || l.cancelPendingCommit !== null)
      return a !== null && a !== null && ui(a), l.callbackNode = null, l.callbackPriority = 0;
    if ((e & 3) === 0 || qa(l, e)) {
      if (t = e & -e, t === l.callbackPriority) return t;
      switch (a !== null && ui(a), ci(e)) {
        case 2:
        case 8:
          e = Df;
          break;
        case 32:
          e = Uu;
          break;
        case 268435456:
          e = Uf;
          break;
        default:
          e = Uu;
      }
      return a = Zd.bind(null, l), e = ai(e, a), l.callbackPriority = t, l.callbackNode = e, t;
    }
    return a !== null && a !== null && ui(a), l.callbackPriority = 2, l.callbackNode = null, 2;
  }
  function Zd(l, t) {
    if (Ul !== 0 && Ul !== 5)
      return l.callbackNode = null, l.callbackPriority = 0, null;
    var e = l.callbackNode;
    if (Dn() && l.callbackNode !== e)
      return null;
    var a = P;
    return a = qu(
      l,
      l === yl ? a : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), a === 0 ? null : (jd(l, a, t), Xd(l, tt()), l.callbackNode != null && l.callbackNode === e ? Zd.bind(null, l) : null);
  }
  function Vd(l, t) {
    if (Dn()) return null;
    jd(l, t, !0);
  }
  function Dh() {
    Zh(function() {
      (nl & 6) !== 0 ? ai(
        Mf,
        Mh
      ) : Qd();
    });
  }
  function wc() {
    if (be === 0) {
      var l = ra;
      l === 0 && (l = Ru, Ru <<= 1, (Ru & 261888) === 0 && (Ru = 256)), be = l;
    }
    return be;
  }
  function Kd(l) {
    return l == null || typeof l == "symbol" || typeof l == "boolean" ? null : typeof l == "function" ? l : Lu("" + l);
  }
  function Jd(l, t) {
    var e = t.ownerDocument.createElement("input");
    return e.name = t.name, e.value = t.value, l.id && e.setAttribute("form", l.id), t.parentNode.insertBefore(e, t), l = new FormData(l), e.parentNode.removeChild(e), l;
  }
  function Uh(l, t, e, a, u) {
    if (t === "submit" && e && e.stateNode === u) {
      var n = Kd(
        (u[$l] || null).action
      ), i = a.submitter;
      i && (t = (t = i[$l] || null) ? Kd(t.formAction) : i.getAttribute("formAction"), t !== null && (n = t, i = null));
      var c = new Vu(
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
                  var s = i ? Jd(u, i) : new FormData(u);
                  mc(
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
                typeof n == "function" && (c.preventDefault(), s = i ? Jd(u, i) : new FormData(u), mc(
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
  for (var $c = 0; $c < Mi.length; $c++) {
    var Wc = Mi[$c], Rh = Wc.toLowerCase(), Ch = Wc[0].toUpperCase() + Wc.slice(1);
    jt(
      Rh,
      "on" + Ch
    );
  }
  jt(zs, "onAnimationEnd"), jt(Ts, "onAnimationIteration"), jt(js, "onAnimationStart"), jt("dblclick", "onDoubleClick"), jt("focusin", "onFocus"), jt("focusout", "onBlur"), jt(km, "onTransitionRun"), jt(Fm, "onTransitionStart"), jt(Im, "onTransitionCancel"), jt(Es, "onTransitionEnd"), Ie("onMouseEnter", ["mouseout", "mouseover"]), Ie("onMouseLeave", ["mouseout", "mouseover"]), Ie("onPointerEnter", ["pointerout", "pointerover"]), Ie("onPointerLeave", ["pointerout", "pointerover"]), _e(
    "onChange",
    "change click focusin focusout input keydown keyup selectionchange".split(" ")
  ), _e(
    "onSelect",
    "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(
      " "
    )
  ), _e("onBeforeInput", [
    "compositionend",
    "keypress",
    "textInput",
    "paste"
  ]), _e(
    "onCompositionEnd",
    "compositionend focusout keydown keypress keyup mousedown".split(" ")
  ), _e(
    "onCompositionStart",
    "compositionstart focusout keydown keypress keyup mousedown".split(" ")
  ), _e(
    "onCompositionUpdate",
    "compositionupdate focusout keydown keypress keyup mousedown".split(" ")
  );
  var bu = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
    " "
  ), Hh = new Set(
    "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(bu)
  );
  function wd(l, t) {
    t = (t & 4) !== 0;
    for (var e = 0; e < l.length; e++) {
      var a = l[e], u = a.event;
      a = a.listeners;
      l: {
        var n = void 0;
        if (t)
          for (var i = a.length - 1; 0 <= i; i--) {
            var c = a[i], s = c.instance, v = c.currentTarget;
            if (c = c.listener, s !== n && u.isPropagationStopped())
              break l;
            n = c, u.currentTarget = v;
            try {
              n(u);
            } catch (p) {
              wu(p);
            }
            u.currentTarget = null, n = s;
          }
        else
          for (i = 0; i < a.length; i++) {
            if (c = a[i], s = c.instance, v = c.currentTarget, c = c.listener, s !== n && u.isPropagationStopped())
              break l;
            n = c, u.currentTarget = v;
            try {
              n(u);
            } catch (p) {
              wu(p);
            }
            u.currentTarget = null, n = s;
          }
      }
    }
  }
  function I(l, t) {
    var e = t[fi];
    e === void 0 && (e = t[fi] = /* @__PURE__ */ new Set());
    var a = l + "__bubble";
    e.has(a) || ($d(t, l, 2, !1), e.add(a));
  }
  function kc(l, t, e) {
    var a = 0;
    t && (a |= 4), $d(
      e,
      l,
      a,
      t
    );
  }
  var Cn = "_reactListening" + Math.random().toString(36).slice(2);
  function Fc(l) {
    if (!l[Cn]) {
      l[Cn] = !0, Lf.forEach(function(e) {
        e !== "selectionchange" && (Hh.has(e) || kc(e, !1, l), kc(e, !0, l));
      });
      var t = l.nodeType === 9 ? l : l.ownerDocument;
      t === null || t[Cn] || (t[Cn] = !0, kc("selectionchange", !1, t));
    }
  }
  function $d(l, t, e, a) {
    switch (Tr(t)) {
      case 2:
        var u = sy;
        break;
      case 8:
        u = oy;
        break;
      default:
        u = mf;
    }
    e = u.bind(
      null,
      t,
      e,
      l
    ), u = void 0, !gi || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (u = !0), a ? u !== void 0 ? l.addEventListener(t, e, {
      capture: !0,
      passive: u
    }) : l.addEventListener(t, e, !0) : u !== void 0 ? l.addEventListener(t, e, {
      passive: u
    }) : l.addEventListener(t, e, !1);
  }
  function Ic(l, t, e, a, u) {
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
            if (i = We(c), i === null) return;
            if (s = i.tag, s === 5 || s === 6 || s === 26 || s === 27) {
              a = n = i;
              continue l;
            }
            c = c.parentNode;
          }
        }
        a = a.return;
      }
    If(function() {
      var v = n, p = yi(e), j = [];
      l: {
        var g = xs.get(l);
        if (g !== void 0) {
          var b = Vu, H = l;
          switch (l) {
            case "keypress":
              if (Xu(e) === 0) break l;
            case "keydown":
            case "keyup":
              b = Om;
              break;
            case "focusin":
              H = "focus", b = Ai;
              break;
            case "focusout":
              H = "blur", b = Ai;
              break;
            case "beforeblur":
            case "afterblur":
              b = Ai;
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
              b = ts;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              b = vm;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              b = Dm;
              break;
            case zs:
            case Ts:
            case js:
              b = Sm;
              break;
            case Es:
              b = Rm;
              break;
            case "scroll":
            case "scrollend":
              b = hm;
              break;
            case "wheel":
              b = Hm;
              break;
            case "copy":
            case "cut":
            case "paste":
              b = Am;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              b = as;
              break;
            case "toggle":
            case "beforetoggle":
              b = Bm;
          }
          var L = (t & 4) !== 0, ml = !L && (l === "scroll" || l === "scrollend"), h = L ? g !== null ? g + "Capture" : null : g;
          L = [];
          for (var d = v, y; d !== null; ) {
            var z = d;
            if (y = z.stateNode, z = z.tag, z !== 5 && z !== 26 && z !== 27 || y === null || h === null || (z = La(d, h), z != null && L.push(
              Su(d, z, y)
            )), ml) break;
            d = d.return;
          }
          0 < L.length && (g = new b(
            g,
            H,
            null,
            e,
            p
          ), j.push({ event: g, listeners: L }));
        }
      }
      if ((t & 7) === 0) {
        l: {
          if (g = l === "mouseover" || l === "pointerover", b = l === "mouseout" || l === "pointerout", g && e !== hi && (H = e.relatedTarget || e.fromElement) && (We(H) || H[$e]))
            break l;
          if ((b || g) && (g = p.window === p ? p : (g = p.ownerDocument) ? g.defaultView || g.parentWindow : window, b ? (H = e.relatedTarget || e.toElement, b = v, H = H ? We(H) : null, H !== null && (ml = D(H), L = H.tag, H !== ml || L !== 5 && L !== 27 && L !== 6) && (H = null)) : (b = null, H = v), b !== H)) {
            if (L = ts, z = "onMouseLeave", h = "onMouseEnter", d = "mouse", (l === "pointerout" || l === "pointerover") && (L = as, z = "onPointerLeave", h = "onPointerEnter", d = "pointer"), ml = b == null ? g : Ga(b), y = H == null ? g : Ga(H), g = new L(
              z,
              d + "leave",
              b,
              e,
              p
            ), g.target = ml, g.relatedTarget = y, z = null, We(p) === v && (L = new L(
              h,
              d + "enter",
              H,
              e,
              p
            ), L.target = y, L.relatedTarget = ml, z = L), ml = z, b && H)
              t: {
                for (L = qh, h = b, d = H, y = 0, z = h; z; z = L(z))
                  y++;
                z = 0;
                for (var G = d; G; G = L(G))
                  z++;
                for (; 0 < y - z; )
                  h = L(h), y--;
                for (; 0 < z - y; )
                  d = L(d), z--;
                for (; y--; ) {
                  if (h === d || d !== null && h === d.alternate) {
                    L = h;
                    break t;
                  }
                  h = L(h), d = L(d);
                }
                L = null;
              }
            else L = null;
            b !== null && Wd(
              j,
              g,
              b,
              L,
              !1
            ), H !== null && ml !== null && Wd(
              j,
              ml,
              H,
              L,
              !0
            );
          }
        }
        l: {
          if (g = v ? Ga(v) : window, b = g.nodeName && g.nodeName.toLowerCase(), b === "select" || b === "input" && g.type === "file")
            var al = ds;
          else if (ss(g))
            if (rs)
              al = wm;
            else {
              al = Km;
              var Y = Vm;
            }
          else
            b = g.nodeName, !b || b.toLowerCase() !== "input" || g.type !== "checkbox" && g.type !== "radio" ? v && mi(v.elementType) && (al = ds) : al = Jm;
          if (al && (al = al(l, v))) {
            os(
              j,
              al,
              e,
              p
            );
            break l;
          }
          Y && Y(l, g, v), l === "focusout" && v && g.type === "number" && v.memoizedProps.value != null && ri(g, "number", g.value);
        }
        switch (Y = v ? Ga(v) : window, l) {
          case "focusin":
            (ss(Y) || Y.contentEditable === "true") && (ua = Y, Ni = v, $a = null);
            break;
          case "focusout":
            $a = Ni = ua = null;
            break;
          case "mousedown":
            Oi = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            Oi = !1, ps(j, e, p);
            break;
          case "selectionchange":
            if (Wm) break;
          case "keydown":
          case "keyup":
            ps(j, e, p);
        }
        var $;
        if (Ti)
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
          aa ? cs(l, e) && (ll = "onCompositionEnd") : l === "keydown" && e.keyCode === 229 && (ll = "onCompositionStart");
        ll && (us && e.locale !== "ko" && (aa || ll !== "onCompositionStart" ? ll === "onCompositionEnd" && aa && ($ = Pf()) : (ee = p, bi = "value" in ee ? ee.value : ee.textContent, aa = !0)), Y = Hn(v, ll), 0 < Y.length && (ll = new es(
          ll,
          l,
          null,
          e,
          p
        ), j.push({ event: ll, listeners: Y }), $ ? ll.data = $ : ($ = fs(e), $ !== null && (ll.data = $)))), ($ = Gm ? Lm(l, e) : Qm(l, e)) && (ll = Hn(v, "onBeforeInput"), 0 < ll.length && (Y = new es(
          "onBeforeInput",
          "beforeinput",
          null,
          e,
          p
        ), j.push({
          event: Y,
          listeners: ll
        }), Y.data = $)), Uh(
          j,
          l,
          v,
          e,
          p
        );
      }
      wd(j, t);
    });
  }
  function Su(l, t, e) {
    return {
      instance: l,
      listener: t,
      currentTarget: e
    };
  }
  function Hn(l, t) {
    for (var e = t + "Capture", a = []; l !== null; ) {
      var u = l, n = u.stateNode;
      if (u = u.tag, u !== 5 && u !== 26 && u !== 27 || n === null || (u = La(l, e), u != null && a.unshift(
        Su(l, u, n)
      ), u = La(l, t), u != null && a.push(
        Su(l, u, n)
      )), l.tag === 3) return a;
      l = l.return;
    }
    return [];
  }
  function qh(l) {
    if (l === null) return null;
    do
      l = l.return;
    while (l && l.tag !== 5 && l.tag !== 27);
    return l || null;
  }
  function Wd(l, t, e, a, u) {
    for (var n = t._reactName, i = []; e !== null && e !== a; ) {
      var c = e, s = c.alternate, v = c.stateNode;
      if (c = c.tag, s !== null && s === a) break;
      c !== 5 && c !== 26 && c !== 27 || v === null || (s = v, u ? (v = La(e, n), v != null && i.unshift(
        Su(e, v, s)
      )) : u || (v = La(e, n), v != null && i.push(
        Su(e, v, s)
      ))), e = e.return;
    }
    i.length !== 0 && l.push({ event: t, listeners: i });
  }
  var Bh = /\r\n?/g, Yh = /\u0000|\uFFFD/g;
  function kd(l) {
    return (typeof l == "string" ? l : "" + l).replace(Bh, `
`).replace(Yh, "");
  }
  function Fd(l, t) {
    return t = kd(t), kd(l) === t;
  }
  function rl(l, t, e, a, u, n) {
    switch (e) {
      case "children":
        typeof a == "string" ? t === "body" || t === "textarea" && a === "" || la(l, a) : (typeof a == "number" || typeof a == "bigint") && t !== "body" && la(l, "" + a);
        break;
      case "className":
        Yu(l, "class", a);
        break;
      case "tabIndex":
        Yu(l, "tabindex", a);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        Yu(l, e, a);
        break;
      case "style":
        kf(l, a, n);
        break;
      case "data":
        if (t !== "object") {
          Yu(l, "data", a);
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
        a = Lu("" + a), l.setAttribute(e, a);
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
        a = Lu("" + a), l.setAttribute(e, a);
        break;
      case "onClick":
        a != null && (l.onclick = Ct);
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
            throw Error(m(61));
          if (e = a.__html, e != null) {
            if (u.children != null) throw Error(m(60));
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
        e = Lu("" + a), l.setAttributeNS(
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
        I("beforetoggle", l), I("toggle", l), Bu(l, "popover", a);
        break;
      case "xlinkActuate":
        Rt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:actuate",
          a
        );
        break;
      case "xlinkArcrole":
        Rt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:arcrole",
          a
        );
        break;
      case "xlinkRole":
        Rt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:role",
          a
        );
        break;
      case "xlinkShow":
        Rt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:show",
          a
        );
        break;
      case "xlinkTitle":
        Rt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:title",
          a
        );
        break;
      case "xlinkType":
        Rt(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:type",
          a
        );
        break;
      case "xmlBase":
        Rt(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:base",
          a
        );
        break;
      case "xmlLang":
        Rt(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:lang",
          a
        );
        break;
      case "xmlSpace":
        Rt(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:space",
          a
        );
        break;
      case "is":
        Bu(l, "is", a);
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        (!(2 < e.length) || e[0] !== "o" && e[0] !== "O" || e[1] !== "n" && e[1] !== "N") && (e = rm.get(e) || e, Bu(l, e, a));
    }
  }
  function Pc(l, t, e, a, u, n) {
    switch (e) {
      case "style":
        kf(l, a, n);
        break;
      case "dangerouslySetInnerHTML":
        if (a != null) {
          if (typeof a != "object" || !("__html" in a))
            throw Error(m(61));
          if (e = a.__html, e != null) {
            if (u.children != null) throw Error(m(60));
            l.innerHTML = e;
          }
        }
        break;
      case "children":
        typeof a == "string" ? la(l, a) : (typeof a == "number" || typeof a == "bigint") && la(l, "" + a);
        break;
      case "onScroll":
        a != null && I("scroll", l);
        break;
      case "onScrollEnd":
        a != null && I("scrollend", l);
        break;
      case "onClick":
        a != null && (l.onclick = Ct);
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
            if (e[0] === "o" && e[1] === "n" && (u = e.endsWith("Capture"), t = e.slice(2, u ? e.length - 7 : void 0), n = l[$l] || null, n = n != null ? n[e] : null, typeof n == "function" && l.removeEventListener(t, n, u), typeof a == "function")) {
              typeof n != "function" && n !== null && (e in l ? l[e] = null : l.hasAttribute(e) && l.removeAttribute(e)), l.addEventListener(t, a, u);
              break l;
            }
            e in l ? l[e] = a : a === !0 ? l.setAttribute(e, "") : Bu(l, e, a);
          }
    }
  }
  function Ql(l, t, e) {
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
                  throw Error(m(137, t));
                default:
                  rl(l, t, n, i, e, null);
              }
          }
        u && rl(l, t, "srcSet", e.srcSet, e, null), a && rl(l, t, "src", e.src, e, null);
        return;
      case "input":
        I("invalid", l);
        var c = n = i = u = null, s = null, v = null;
        for (a in e)
          if (e.hasOwnProperty(a)) {
            var p = e[a];
            if (p != null)
              switch (a) {
                case "name":
                  u = p;
                  break;
                case "type":
                  i = p;
                  break;
                case "checked":
                  s = p;
                  break;
                case "defaultChecked":
                  v = p;
                  break;
                case "value":
                  n = p;
                  break;
                case "defaultValue":
                  c = p;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  if (p != null)
                    throw Error(m(137, t));
                  break;
                default:
                  rl(l, t, a, p, e, null);
              }
          }
        Jf(
          l,
          n,
          c,
          s,
          v,
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
        t = n, e = i, l.multiple = !!a, t != null ? Pe(l, !!a, t, !1) : e != null && Pe(l, !!a, e, !0);
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
                if (c != null) throw Error(m(91));
                break;
              default:
                rl(l, t, i, c, e, null);
            }
        $f(l, a, u, n);
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
        for (v in e)
          if (e.hasOwnProperty(v) && (a = e[v], a != null))
            switch (v) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(m(137, t));
              default:
                rl(l, t, v, a, e, null);
            }
        return;
      default:
        if (mi(t)) {
          for (p in e)
            e.hasOwnProperty(p) && (a = e[p], a !== void 0 && Pc(
              l,
              t,
              p,
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
  function Gh(l, t, e, a) {
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
        var u = null, n = null, i = null, c = null, s = null, v = null, p = null;
        for (b in e) {
          var j = e[b];
          if (e.hasOwnProperty(b) && j != null)
            switch (b) {
              case "checked":
                break;
              case "value":
                break;
              case "defaultValue":
                s = j;
              default:
                a.hasOwnProperty(b) || rl(l, t, b, null, a, j);
            }
        }
        for (var g in a) {
          var b = a[g];
          if (j = e[g], a.hasOwnProperty(g) && (b != null || j != null))
            switch (g) {
              case "type":
                n = b;
                break;
              case "name":
                u = b;
                break;
              case "checked":
                v = b;
                break;
              case "defaultChecked":
                p = b;
                break;
              case "value":
                i = b;
                break;
              case "defaultValue":
                c = b;
                break;
              case "children":
              case "dangerouslySetInnerHTML":
                if (b != null)
                  throw Error(m(137, t));
                break;
              default:
                b !== j && rl(
                  l,
                  t,
                  g,
                  b,
                  a,
                  j
                );
            }
        }
        di(
          l,
          i,
          c,
          s,
          v,
          p,
          n,
          u
        );
        return;
      case "select":
        b = i = c = g = null;
        for (n in e)
          if (s = e[n], e.hasOwnProperty(n) && s != null)
            switch (n) {
              case "value":
                break;
              case "multiple":
                b = s;
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
        t = c, e = i, a = b, g != null ? Pe(l, !!e, g, !1) : !!a != !!e && (t != null ? Pe(l, !!e, t, !0) : Pe(l, !!e, e ? [] : "", !1));
        return;
      case "textarea":
        b = g = null;
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
                b = u;
                break;
              case "children":
                break;
              case "dangerouslySetInnerHTML":
                if (u != null) throw Error(m(91));
                break;
              default:
                u !== n && rl(l, t, i, u, a, n);
            }
        wf(l, g, b);
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
          g = a[s], b = e[s], a.hasOwnProperty(s) && g !== b && (g != null || b != null) && (s === "selected" ? l.selected = g && typeof g != "function" && typeof g != "symbol" : rl(
            l,
            t,
            s,
            g,
            a,
            b
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
        for (v in a)
          if (g = a[v], b = e[v], a.hasOwnProperty(v) && g !== b && (g != null || b != null))
            switch (v) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (g != null)
                  throw Error(m(137, t));
                break;
              default:
                rl(
                  l,
                  t,
                  v,
                  g,
                  a,
                  b
                );
            }
        return;
      default:
        if (mi(t)) {
          for (var ml in e)
            g = e[ml], e.hasOwnProperty(ml) && g !== void 0 && !a.hasOwnProperty(ml) && Pc(
              l,
              t,
              ml,
              void 0,
              a,
              g
            );
          for (p in a)
            g = a[p], b = e[p], !a.hasOwnProperty(p) || g === b || g === void 0 && b === void 0 || Pc(
              l,
              t,
              p,
              g,
              a,
              b
            );
          return;
        }
    }
    for (var h in e)
      g = e[h], e.hasOwnProperty(h) && g != null && !a.hasOwnProperty(h) && rl(l, t, h, null, a, g);
    for (j in a)
      g = a[j], b = e[j], !a.hasOwnProperty(j) || g === b || g == null && b == null || rl(l, t, j, g, a, b);
  }
  function Id(l) {
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
  function Lh() {
    if (typeof performance.getEntriesByType == "function") {
      for (var l = 0, t = 0, e = performance.getEntriesByType("resource"), a = 0; a < e.length; a++) {
        var u = e[a], n = u.transferSize, i = u.initiatorType, c = u.duration;
        if (n && c && Id(i)) {
          for (i = 0, c = u.responseEnd, a += 1; a < e.length; a++) {
            var s = e[a], v = s.startTime;
            if (v > c) break;
            var p = s.transferSize, j = s.initiatorType;
            p && Id(j) && (s = s.responseEnd, i += p * (s < c ? 1 : (c - v) / (s - v)));
          }
          if (--a, t += 8 * (n + i) / (u.duration / 1e3), l++, 10 < l) break;
        }
      }
      if (0 < l) return t / l / 1e6;
    }
    return navigator.connection && (l = navigator.connection.downlink, typeof l == "number") ? l : 5;
  }
  var lf = null, tf = null;
  function qn(l) {
    return l.nodeType === 9 ? l : l.ownerDocument;
  }
  function Pd(l) {
    switch (l) {
      case "http://www.w3.org/2000/svg":
        return 1;
      case "http://www.w3.org/1998/Math/MathML":
        return 2;
      default:
        return 0;
    }
  }
  function lr(l, t) {
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
  function ef(l, t) {
    return l === "textarea" || l === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.children == "bigint" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
  }
  var af = null;
  function Qh() {
    var l = window.event;
    return l && l.type === "popstate" ? l === af ? !1 : (af = l, !0) : (af = null, !1);
  }
  var tr = typeof setTimeout == "function" ? setTimeout : void 0, Xh = typeof clearTimeout == "function" ? clearTimeout : void 0, er = typeof Promise == "function" ? Promise : void 0, Zh = typeof queueMicrotask == "function" ? queueMicrotask : typeof er < "u" ? function(l) {
    return er.resolve(null).then(l).catch(Vh);
  } : tr;
  function Vh(l) {
    setTimeout(function() {
      throw l;
    });
  }
  function Se(l) {
    return l === "head";
  }
  function ar(l, t) {
    var e = t, a = 0;
    do {
      var u = e.nextSibling;
      if (l.removeChild(e), u && u.nodeType === 8)
        if (e = u.data, e === "/$" || e === "/&") {
          if (a === 0) {
            l.removeChild(u), Da(t);
            return;
          }
          a--;
        } else if (e === "$" || e === "$?" || e === "$~" || e === "$!" || e === "&")
          a++;
        else if (e === "html")
          pu(l.ownerDocument.documentElement);
        else if (e === "head") {
          e = l.ownerDocument.head, pu(e);
          for (var n = e.firstChild; n; ) {
            var i = n.nextSibling, c = n.nodeName;
            n[Ya] || c === "SCRIPT" || c === "STYLE" || c === "LINK" && n.rel.toLowerCase() === "stylesheet" || e.removeChild(n), n = i;
          }
        } else
          e === "body" && pu(l.ownerDocument.body);
      e = u;
    } while (e);
    Da(t);
  }
  function ur(l, t) {
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
  function uf(l) {
    var t = l.firstChild;
    for (t && t.nodeType === 10 && (t = t.nextSibling); t; ) {
      var e = t;
      switch (t = t.nextSibling, e.nodeName) {
        case "HTML":
        case "HEAD":
        case "BODY":
          uf(e), si(e);
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
  function Kh(l, t, e, a) {
    for (; l.nodeType === 1; ) {
      var u = e;
      if (l.nodeName.toLowerCase() !== t.toLowerCase()) {
        if (!a && (l.nodeName !== "INPUT" || l.type !== "hidden"))
          break;
      } else if (a) {
        if (!l[Ya])
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
      if (l = At(l.nextSibling), l === null) break;
    }
    return null;
  }
  function Jh(l, t, e) {
    if (t === "") return null;
    for (; l.nodeType !== 3; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !e || (l = At(l.nextSibling), l === null)) return null;
    return l;
  }
  function nr(l, t) {
    for (; l.nodeType !== 8; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !t || (l = At(l.nextSibling), l === null)) return null;
    return l;
  }
  function nf(l) {
    return l.data === "$?" || l.data === "$~";
  }
  function cf(l) {
    return l.data === "$!" || l.data === "$?" && l.ownerDocument.readyState !== "loading";
  }
  function wh(l, t) {
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
  function At(l) {
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
  var ff = null;
  function ir(l) {
    l = l.nextSibling;
    for (var t = 0; l; ) {
      if (l.nodeType === 8) {
        var e = l.data;
        if (e === "/$" || e === "/&") {
          if (t === 0)
            return At(l.nextSibling);
          t--;
        } else
          e !== "$" && e !== "$!" && e !== "$?" && e !== "$~" && e !== "&" || t++;
      }
      l = l.nextSibling;
    }
    return null;
  }
  function cr(l) {
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
  function fr(l, t, e) {
    switch (t = qn(e), l) {
      case "html":
        if (l = t.documentElement, !l) throw Error(m(452));
        return l;
      case "head":
        if (l = t.head, !l) throw Error(m(453));
        return l;
      case "body":
        if (l = t.body, !l) throw Error(m(454));
        return l;
      default:
        throw Error(m(451));
    }
  }
  function pu(l) {
    for (var t = l.attributes; t.length; )
      l.removeAttributeNode(t[0]);
    si(l);
  }
  var zt = /* @__PURE__ */ new Map(), sr = /* @__PURE__ */ new Set();
  function Bn(l) {
    return typeof l.getRootNode == "function" ? l.getRootNode() : l.nodeType === 9 ? l : l.ownerDocument;
  }
  var kt = U.d;
  U.d = {
    f: $h,
    r: Wh,
    D: kh,
    C: Fh,
    L: Ih,
    m: Ph,
    X: ty,
    S: ly,
    M: ey
  };
  function $h() {
    var l = kt.f(), t = On();
    return l || t;
  }
  function Wh(l) {
    var t = ke(l);
    t !== null && t.tag === 5 && t.type === "form" ? xo(t) : kt.r(l);
  }
  var Oa = typeof document > "u" ? null : document;
  function or(l, t, e) {
    var a = Oa;
    if (a && typeof t == "string" && t) {
      var u = ht(t);
      u = 'link[rel="' + l + '"][href="' + u + '"]', typeof e == "string" && (u += '[crossorigin="' + e + '"]'), sr.has(u) || (sr.add(u), l = { rel: l, crossOrigin: e, href: t }, a.querySelector(u) === null && (t = a.createElement("link"), Ql(t, "link", l), Hl(t), a.head.appendChild(t)));
    }
  }
  function kh(l) {
    kt.D(l), or("dns-prefetch", l, null);
  }
  function Fh(l, t) {
    kt.C(l, t), or("preconnect", l, t);
  }
  function Ih(l, t, e) {
    kt.L(l, t, e);
    var a = Oa;
    if (a && l && t) {
      var u = 'link[rel="preload"][as="' + ht(t) + '"]';
      t === "image" && e && e.imageSrcSet ? (u += '[imagesrcset="' + ht(
        e.imageSrcSet
      ) + '"]', typeof e.imageSizes == "string" && (u += '[imagesizes="' + ht(
        e.imageSizes
      ) + '"]')) : u += '[href="' + ht(l) + '"]';
      var n = u;
      switch (t) {
        case "style":
          n = _a(l);
          break;
        case "script":
          n = Ma(l);
      }
      zt.has(n) || (l = T(
        {
          rel: "preload",
          href: t === "image" && e && e.imageSrcSet ? void 0 : l,
          as: t
        },
        e
      ), zt.set(n, l), a.querySelector(u) !== null || t === "style" && a.querySelector(Au(n)) || t === "script" && a.querySelector(zu(n)) || (t = a.createElement("link"), Ql(t, "link", l), Hl(t), a.head.appendChild(t)));
    }
  }
  function Ph(l, t) {
    kt.m(l, t);
    var e = Oa;
    if (e && l) {
      var a = t && typeof t.as == "string" ? t.as : "script", u = 'link[rel="modulepreload"][as="' + ht(a) + '"][href="' + ht(l) + '"]', n = u;
      switch (a) {
        case "audioworklet":
        case "paintworklet":
        case "serviceworker":
        case "sharedworker":
        case "worker":
        case "script":
          n = Ma(l);
      }
      if (!zt.has(n) && (l = T({ rel: "modulepreload", href: l }, t), zt.set(n, l), e.querySelector(u) === null)) {
        switch (a) {
          case "audioworklet":
          case "paintworklet":
          case "serviceworker":
          case "sharedworker":
          case "worker":
          case "script":
            if (e.querySelector(zu(n)))
              return;
        }
        a = e.createElement("link"), Ql(a, "link", l), Hl(a), e.head.appendChild(a);
      }
    }
  }
  function ly(l, t, e) {
    kt.S(l, t, e);
    var a = Oa;
    if (a && l) {
      var u = Fe(a).hoistableStyles, n = _a(l);
      t = t || "default";
      var i = u.get(n);
      if (!i) {
        var c = { loading: 0, preload: null };
        if (i = a.querySelector(
          Au(n)
        ))
          c.loading = 5;
        else {
          l = T(
            { rel: "stylesheet", href: l, "data-precedence": t },
            e
          ), (e = zt.get(n)) && sf(l, e);
          var s = i = a.createElement("link");
          Hl(s), Ql(s, "link", l), s._p = new Promise(function(v, p) {
            s.onload = v, s.onerror = p;
          }), s.addEventListener("load", function() {
            c.loading |= 1;
          }), s.addEventListener("error", function() {
            c.loading |= 2;
          }), c.loading |= 4, Yn(i, t, a);
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
  function ty(l, t) {
    kt.X(l, t);
    var e = Oa;
    if (e && l) {
      var a = Fe(e).hoistableScripts, u = Ma(l), n = a.get(u);
      n || (n = e.querySelector(zu(u)), n || (l = T({ src: l, async: !0 }, t), (t = zt.get(u)) && of(l, t), n = e.createElement("script"), Hl(n), Ql(n, "link", l), e.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, a.set(u, n));
    }
  }
  function ey(l, t) {
    kt.M(l, t);
    var e = Oa;
    if (e && l) {
      var a = Fe(e).hoistableScripts, u = Ma(l), n = a.get(u);
      n || (n = e.querySelector(zu(u)), n || (l = T({ src: l, async: !0, type: "module" }, t), (t = zt.get(u)) && of(l, t), n = e.createElement("script"), Hl(n), Ql(n, "link", l), e.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, a.set(u, n));
    }
  }
  function dr(l, t, e, a) {
    var u = (u = k.current) ? Bn(u) : null;
    if (!u) throw Error(m(446));
    switch (l) {
      case "meta":
      case "title":
        return null;
      case "style":
        return typeof e.precedence == "string" && typeof e.href == "string" ? (t = _a(e.href), e = Fe(
          u
        ).hoistableStyles, a = e.get(t), a || (a = {
          type: "style",
          instance: null,
          count: 0,
          state: null
        }, e.set(t, a)), a) : { type: "void", instance: null, count: 0, state: null };
      case "link":
        if (e.rel === "stylesheet" && typeof e.href == "string" && typeof e.precedence == "string") {
          l = _a(e.href);
          var n = Fe(
            u
          ).hoistableStyles, i = n.get(l);
          if (i || (u = u.ownerDocument || u, i = {
            type: "stylesheet",
            instance: null,
            count: 0,
            state: { loading: 0, preload: null }
          }, n.set(l, i), (n = u.querySelector(
            Au(l)
          )) && !n._p && (i.instance = n, i.state.loading = 5), zt.has(l) || (e = {
            rel: "preload",
            as: "style",
            href: e.href,
            crossOrigin: e.crossOrigin,
            integrity: e.integrity,
            media: e.media,
            hrefLang: e.hrefLang,
            referrerPolicy: e.referrerPolicy
          }, zt.set(l, e), n || ay(
            u,
            l,
            e,
            i.state
          ))), t && a === null)
            throw Error(m(528, ""));
          return i;
        }
        if (t && a !== null)
          throw Error(m(529, ""));
        return null;
      case "script":
        return t = e.async, e = e.src, typeof e == "string" && t && typeof t != "function" && typeof t != "symbol" ? (t = Ma(e), e = Fe(
          u
        ).hoistableScripts, a = e.get(t), a || (a = {
          type: "script",
          instance: null,
          count: 0,
          state: null
        }, e.set(t, a)), a) : { type: "void", instance: null, count: 0, state: null };
      default:
        throw Error(m(444, l));
    }
  }
  function _a(l) {
    return 'href="' + ht(l) + '"';
  }
  function Au(l) {
    return 'link[rel="stylesheet"][' + l + "]";
  }
  function rr(l) {
    return T({}, l, {
      "data-precedence": l.precedence,
      precedence: null
    });
  }
  function ay(l, t, e, a) {
    l.querySelector('link[rel="preload"][as="style"][' + t + "]") ? a.loading = 1 : (t = l.createElement("link"), a.preload = t, t.addEventListener("load", function() {
      return a.loading |= 1;
    }), t.addEventListener("error", function() {
      return a.loading |= 2;
    }), Ql(t, "link", e), Hl(t), l.head.appendChild(t));
  }
  function Ma(l) {
    return '[src="' + ht(l) + '"]';
  }
  function zu(l) {
    return "script[async]" + l;
  }
  function mr(l, t, e) {
    if (t.count++, t.instance === null)
      switch (t.type) {
        case "style":
          var a = l.querySelector(
            'style[data-href~="' + ht(e.href) + '"]'
          );
          if (a)
            return t.instance = a, Hl(a), a;
          var u = T({}, e, {
            "data-href": e.href,
            "data-precedence": e.precedence,
            href: null,
            precedence: null
          });
          return a = (l.ownerDocument || l).createElement(
            "style"
          ), Hl(a), Ql(a, "style", u), Yn(a, e.precedence, l), t.instance = a;
        case "stylesheet":
          u = _a(e.href);
          var n = l.querySelector(
            Au(u)
          );
          if (n)
            return t.state.loading |= 4, t.instance = n, Hl(n), n;
          a = rr(e), (u = zt.get(u)) && sf(a, u), n = (l.ownerDocument || l).createElement("link"), Hl(n);
          var i = n;
          return i._p = new Promise(function(c, s) {
            i.onload = c, i.onerror = s;
          }), Ql(n, "link", a), t.state.loading |= 4, Yn(n, e.precedence, l), t.instance = n;
        case "script":
          return n = Ma(e.src), (u = l.querySelector(
            zu(n)
          )) ? (t.instance = u, Hl(u), u) : (a = e, (u = zt.get(n)) && (a = T({}, e), of(a, u)), l = l.ownerDocument || l, u = l.createElement("script"), Hl(u), Ql(u, "link", a), l.head.appendChild(u), t.instance = u);
        case "void":
          return null;
        default:
          throw Error(m(443, t.type));
      }
    else
      t.type === "stylesheet" && (t.state.loading & 4) === 0 && (a = t.instance, t.state.loading |= 4, Yn(a, e.precedence, l));
    return t.instance;
  }
  function Yn(l, t, e) {
    for (var a = e.querySelectorAll(
      'link[rel="stylesheet"][data-precedence],style[data-precedence]'
    ), u = a.length ? a[a.length - 1] : null, n = u, i = 0; i < a.length; i++) {
      var c = a[i];
      if (c.dataset.precedence === t) n = c;
      else if (n !== u) break;
    }
    n ? n.parentNode.insertBefore(l, n.nextSibling) : (t = e.nodeType === 9 ? e.head : e, t.insertBefore(l, t.firstChild));
  }
  function sf(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.title == null && (l.title = t.title);
  }
  function of(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.integrity == null && (l.integrity = t.integrity);
  }
  var Gn = null;
  function hr(l, t, e) {
    if (Gn === null) {
      var a = /* @__PURE__ */ new Map(), u = Gn = /* @__PURE__ */ new Map();
      u.set(e, a);
    } else
      u = Gn, a = u.get(e), a || (a = /* @__PURE__ */ new Map(), u.set(e, a));
    if (a.has(l)) return a;
    for (a.set(l, null), e = e.getElementsByTagName(l), u = 0; u < e.length; u++) {
      var n = e[u];
      if (!(n[Ya] || n[Bl] || l === "link" && n.getAttribute("rel") === "stylesheet") && n.namespaceURI !== "http://www.w3.org/2000/svg") {
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
  function uy(l, t, e) {
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
  function vr(l) {
    return !(l.type === "stylesheet" && (l.state.loading & 3) === 0);
  }
  function ny(l, t, e, a) {
    if (e.type === "stylesheet" && (typeof a.media != "string" || matchMedia(a.media).matches !== !1) && (e.state.loading & 4) === 0) {
      if (e.instance === null) {
        var u = _a(a.href), n = t.querySelector(
          Au(u)
        );
        if (n) {
          t = n._p, t !== null && typeof t == "object" && typeof t.then == "function" && (l.count++, l = Ln.bind(l), t.then(l, l)), e.state.loading |= 4, e.instance = n, Hl(n);
          return;
        }
        n = t.ownerDocument || t, a = rr(a), (u = zt.get(u)) && sf(a, u), n = n.createElement("link"), Hl(n);
        var i = n;
        i._p = new Promise(function(c, s) {
          i.onload = c, i.onerror = s;
        }), Ql(n, "link", a), e.instance = n;
      }
      l.stylesheets === null && (l.stylesheets = /* @__PURE__ */ new Map()), l.stylesheets.set(e, t), (t = e.state.preload) && (e.state.loading & 3) === 0 && (l.count++, e = Ln.bind(l), t.addEventListener("load", e), t.addEventListener("error", e));
    }
  }
  var df = 0;
  function iy(l, t) {
    return l.stylesheets && l.count === 0 && Xn(l, l.stylesheets), 0 < l.count || 0 < l.imgCount ? function(e) {
      var a = setTimeout(function() {
        if (l.stylesheets && Xn(l, l.stylesheets), l.unsuspend) {
          var n = l.unsuspend;
          l.unsuspend = null, n();
        }
      }, 6e4 + t);
      0 < l.imgBytes && df === 0 && (df = 62500 * Lh());
      var u = setTimeout(
        function() {
          if (l.waitingForImages = !1, l.count === 0 && (l.stylesheets && Xn(l, l.stylesheets), l.unsuspend)) {
            var n = l.unsuspend;
            l.unsuspend = null, n();
          }
        },
        (l.imgBytes > df ? 50 : 800) + t
      );
      return l.unsuspend = e, function() {
        l.unsuspend = null, clearTimeout(a), clearTimeout(u);
      };
    } : null;
  }
  function Ln() {
    if (this.count--, this.count === 0 && (this.imgCount === 0 || !this.waitingForImages)) {
      if (this.stylesheets) Xn(this, this.stylesheets);
      else if (this.unsuspend) {
        var l = this.unsuspend;
        this.unsuspend = null, l();
      }
    }
  }
  var Qn = null;
  function Xn(l, t) {
    l.stylesheets = null, l.unsuspend !== null && (l.count++, Qn = /* @__PURE__ */ new Map(), t.forEach(cy, l), Qn = null, Ln.call(l));
  }
  function cy(l, t) {
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
      u = t.instance, i = u.getAttribute("data-precedence"), n = e.get(i) || a, n === a && e.set(null, u), e.set(i, u), this.count++, a = Ln.bind(this), u.addEventListener("load", a), u.addEventListener("error", a), n ? n.parentNode.insertBefore(u, n.nextSibling) : (l = l.nodeType === 9 ? l.head : l, l.insertBefore(u, l.firstChild)), t.state.loading |= 4;
    }
  }
  var Tu = {
    $$typeof: Rl,
    Provider: null,
    Consumer: null,
    _currentValue: Z,
    _currentValue2: Z,
    _threadCount: 0
  };
  function fy(l, t, e, a, u, n, i, c, s) {
    this.tag = 1, this.containerInfo = l, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = ni(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = ni(0), this.hiddenUpdates = ni(null), this.identifierPrefix = a, this.onUncaughtError = u, this.onCaughtError = n, this.onRecoverableError = i, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = s, this.incompleteTransitions = /* @__PURE__ */ new Map();
  }
  function gr(l, t, e, a, u, n, i, c, s, v, p, j) {
    return l = new fy(
      l,
      t,
      e,
      i,
      s,
      v,
      p,
      j,
      c
    ), t = 1, n === !0 && (t |= 24), n = nt(3, null, null, t), l.current = n, n.stateNode = l, t = Zi(), t.refCount++, l.pooledCache = t, t.refCount++, n.memoizedState = {
      element: a,
      isDehydrated: e,
      cache: t
    }, wi(n), l;
  }
  function br(l) {
    return l ? (l = ca, l) : ca;
  }
  function Sr(l, t, e, a, u, n) {
    u = br(u), a.context === null ? a.context = u : a.pendingContext = u, a = fe(t), a.payload = { element: e }, n = n === void 0 ? null : n, n !== null && (a.callback = n), e = se(l, a, t), e !== null && (lt(e, l, t), tu(e, l, t));
  }
  function pr(l, t) {
    if (l = l.memoizedState, l !== null && l.dehydrated !== null) {
      var e = l.retryLane;
      l.retryLane = e !== 0 && e < t ? e : t;
    }
  }
  function rf(l, t) {
    pr(l, t), (l = l.alternate) && pr(l, t);
  }
  function Ar(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = Re(l, 67108864);
      t !== null && lt(t, l, 67108864), rf(l, 67108864);
    }
  }
  function zr(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = ot();
      t = ii(t);
      var e = Re(l, t);
      e !== null && lt(e, l, t), rf(l, t);
    }
  }
  var Zn = !0;
  function sy(l, t, e, a) {
    var u = A.T;
    A.T = null;
    var n = U.p;
    try {
      U.p = 2, mf(l, t, e, a);
    } finally {
      U.p = n, A.T = u;
    }
  }
  function oy(l, t, e, a) {
    var u = A.T;
    A.T = null;
    var n = U.p;
    try {
      U.p = 8, mf(l, t, e, a);
    } finally {
      U.p = n, A.T = u;
    }
  }
  function mf(l, t, e, a) {
    if (Zn) {
      var u = hf(a);
      if (u === null)
        Ic(
          l,
          t,
          a,
          Vn,
          e
        ), jr(l, a);
      else if (ry(
        u,
        l,
        t,
        e,
        a
      ))
        a.stopPropagation();
      else if (jr(l, a), t & 4 && -1 < dy.indexOf(l)) {
        for (; u !== null; ) {
          var n = ke(u);
          if (n !== null)
            switch (n.tag) {
              case 3:
                if (n = n.stateNode, n.current.memoizedState.isDehydrated) {
                  var i = Oe(n.pendingLanes);
                  if (i !== 0) {
                    var c = n;
                    for (c.pendingLanes |= 2, c.entangledLanes |= 2; i; ) {
                      var s = 1 << 31 - at(i);
                      c.entanglements[1] |= s, i &= ~s;
                    }
                    Dt(n), (nl & 6) === 0 && (xn = tt() + 500, gu(0));
                  }
                }
                break;
              case 31:
              case 13:
                c = Re(n, 2), c !== null && lt(c, n, 2), On(), rf(n, 2);
            }
          if (n = hf(a), n === null && Ic(
            l,
            t,
            a,
            Vn,
            e
          ), n === u) break;
          u = n;
        }
        u !== null && a.stopPropagation();
      } else
        Ic(
          l,
          t,
          a,
          null,
          e
        );
    }
  }
  function hf(l) {
    return l = yi(l), yf(l);
  }
  var Vn = null;
  function yf(l) {
    if (Vn = null, l = We(l), l !== null) {
      var t = D(l);
      if (t === null) l = null;
      else {
        var e = t.tag;
        if (e === 13) {
          if (l = Q(t), l !== null) return l;
          l = null;
        } else if (e === 31) {
          if (l = W(t), l !== null) return l;
          l = null;
        } else if (e === 3) {
          if (t.stateNode.current.memoizedState.isDehydrated)
            return t.tag === 3 ? t.stateNode.containerInfo : null;
          l = null;
        } else t !== l && (l = null);
      }
    }
    return Vn = l, null;
  }
  function Tr(l) {
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
        switch (kr()) {
          case Mf:
            return 2;
          case Df:
            return 8;
          case Uu:
          case Fr:
            return 32;
          case Uf:
            return 268435456;
          default:
            return 32;
        }
      default:
        return 32;
    }
  }
  var vf = !1, pe = null, Ae = null, ze = null, ju = /* @__PURE__ */ new Map(), Eu = /* @__PURE__ */ new Map(), Te = [], dy = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
    " "
  );
  function jr(l, t) {
    switch (l) {
      case "focusin":
      case "focusout":
        pe = null;
        break;
      case "dragenter":
      case "dragleave":
        Ae = null;
        break;
      case "mouseover":
      case "mouseout":
        ze = null;
        break;
      case "pointerover":
      case "pointerout":
        ju.delete(t.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        Eu.delete(t.pointerId);
    }
  }
  function xu(l, t, e, a, u, n) {
    return l === null || l.nativeEvent !== n ? (l = {
      blockedOn: t,
      domEventName: e,
      eventSystemFlags: a,
      nativeEvent: n,
      targetContainers: [u]
    }, t !== null && (t = ke(t), t !== null && Ar(t)), l) : (l.eventSystemFlags |= a, t = l.targetContainers, u !== null && t.indexOf(u) === -1 && t.push(u), l);
  }
  function ry(l, t, e, a, u) {
    switch (t) {
      case "focusin":
        return pe = xu(
          pe,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "dragenter":
        return Ae = xu(
          Ae,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "mouseover":
        return ze = xu(
          ze,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "pointerover":
        var n = u.pointerId;
        return ju.set(
          n,
          xu(
            ju.get(n) || null,
            l,
            t,
            e,
            a,
            u
          )
        ), !0;
      case "gotpointercapture":
        return n = u.pointerId, Eu.set(
          n,
          xu(
            Eu.get(n) || null,
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
  function Er(l) {
    var t = We(l.target);
    if (t !== null) {
      var e = D(t);
      if (e !== null) {
        if (t = e.tag, t === 13) {
          if (t = Q(e), t !== null) {
            l.blockedOn = t, Yf(l.priority, function() {
              zr(e);
            });
            return;
          }
        } else if (t === 31) {
          if (t = W(e), t !== null) {
            l.blockedOn = t, Yf(l.priority, function() {
              zr(e);
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
  function Kn(l) {
    if (l.blockedOn !== null) return !1;
    for (var t = l.targetContainers; 0 < t.length; ) {
      var e = hf(l.nativeEvent);
      if (e === null) {
        e = l.nativeEvent;
        var a = new e.constructor(
          e.type,
          e
        );
        hi = a, e.target.dispatchEvent(a), hi = null;
      } else
        return t = ke(e), t !== null && Ar(t), l.blockedOn = e, !1;
      t.shift();
    }
    return !0;
  }
  function xr(l, t, e) {
    Kn(l) && e.delete(t);
  }
  function my() {
    vf = !1, pe !== null && Kn(pe) && (pe = null), Ae !== null && Kn(Ae) && (Ae = null), ze !== null && Kn(ze) && (ze = null), ju.forEach(xr), Eu.forEach(xr);
  }
  function Jn(l, t) {
    l.blockedOn === t && (l.blockedOn = null, vf || (vf = !0, o.unstable_scheduleCallback(
      o.unstable_NormalPriority,
      my
    )));
  }
  var wn = null;
  function Nr(l) {
    wn !== l && (wn = l, o.unstable_scheduleCallback(
      o.unstable_NormalPriority,
      function() {
        wn === l && (wn = null);
        for (var t = 0; t < l.length; t += 3) {
          var e = l[t], a = l[t + 1], u = l[t + 2];
          if (typeof a != "function") {
            if (yf(a || e) === null)
              continue;
            break;
          }
          var n = ke(e);
          n !== null && (l.splice(t, 3), t -= 3, mc(
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
  function Da(l) {
    function t(s) {
      return Jn(s, l);
    }
    pe !== null && Jn(pe, l), Ae !== null && Jn(Ae, l), ze !== null && Jn(ze, l), ju.forEach(t), Eu.forEach(t);
    for (var e = 0; e < Te.length; e++) {
      var a = Te[e];
      a.blockedOn === l && (a.blockedOn = null);
    }
    for (; 0 < Te.length && (e = Te[0], e.blockedOn === null); )
      Er(e), e.blockedOn === null && Te.shift();
    if (e = (l.ownerDocument || l).$$reactFormReplay, e != null)
      for (a = 0; a < e.length; a += 3) {
        var u = e[a], n = e[a + 1], i = u[$l] || null;
        if (typeof n == "function")
          i || Nr(e);
        else if (i) {
          var c = null;
          if (n && n.hasAttribute("formAction")) {
            if (u = n, i = n[$l] || null)
              c = i.formAction;
            else if (yf(u) !== null) continue;
          } else c = i.action;
          typeof c == "function" ? e[a + 1] = c : (e.splice(a, 3), a -= 3), Nr(e);
        }
      }
  }
  function Or() {
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
  function gf(l) {
    this._internalRoot = l;
  }
  $n.prototype.render = gf.prototype.render = function(l) {
    var t = this._internalRoot;
    if (t === null) throw Error(m(409));
    var e = t.current, a = ot();
    Sr(e, a, l, t, null, null);
  }, $n.prototype.unmount = gf.prototype.unmount = function() {
    var l = this._internalRoot;
    if (l !== null) {
      this._internalRoot = null;
      var t = l.containerInfo;
      Sr(l.current, 2, null, l, null, null), On(), t[$e] = null;
    }
  };
  function $n(l) {
    this._internalRoot = l;
  }
  $n.prototype.unstable_scheduleHydration = function(l) {
    if (l) {
      var t = Bf();
      l = { blockedOn: null, target: l, priority: t };
      for (var e = 0; e < Te.length && t !== 0 && t < Te[e].priority; e++) ;
      Te.splice(e, 0, l), e === 0 && Er(l);
    }
  };
  var _r = E.version;
  if (_r !== "19.2.8")
    throw Error(
      m(
        527,
        _r,
        "19.2.8"
      )
    );
  U.findDOMNode = function(l) {
    var t = l._reactInternals;
    if (t === void 0)
      throw typeof l.render == "function" ? Error(m(188)) : (l = Object.keys(l).join(","), Error(m(268, l)));
    return l = S(t), l = l !== null ? O(l) : null, l = l === null ? null : l.stateNode, l;
  };
  var hy = {
    bundleType: 0,
    version: "19.2.8",
    rendererPackageName: "react-dom",
    currentDispatcherRef: A,
    reconcilerVersion: "19.2.8"
  };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var Wn = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!Wn.isDisabled && Wn.supportsFiber)
      try {
        Ha = Wn.inject(
          hy
        ), et = Wn;
      } catch {
      }
  }
  return Ou.createRoot = function(l, t) {
    if (!C(l)) throw Error(m(299));
    var e = !1, a = "", u = qo, n = Bo, i = Yo;
    return t != null && (t.unstable_strictMode === !0 && (e = !0), t.identifierPrefix !== void 0 && (a = t.identifierPrefix), t.onUncaughtError !== void 0 && (u = t.onUncaughtError), t.onCaughtError !== void 0 && (n = t.onCaughtError), t.onRecoverableError !== void 0 && (i = t.onRecoverableError)), t = gr(
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
      Or
    ), l[$e] = t.current, Fc(l), new gf(t);
  }, Ou.hydrateRoot = function(l, t, e) {
    if (!C(l)) throw Error(m(299));
    var a = !1, u = "", n = qo, i = Bo, c = Yo, s = null;
    return e != null && (e.unstable_strictMode === !0 && (a = !0), e.identifierPrefix !== void 0 && (u = e.identifierPrefix), e.onUncaughtError !== void 0 && (n = e.onUncaughtError), e.onCaughtError !== void 0 && (i = e.onCaughtError), e.onRecoverableError !== void 0 && (c = e.onRecoverableError), e.formState !== void 0 && (s = e.formState)), t = gr(
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
      Or
    ), t.context = br(null), e = t.current, a = ot(), a = ii(a), u = fe(a), u.callback = null, se(e, u, a), e = a, t.current.lanes = e, Ba(t, e), Dt(t), l[$e] = t.current, Fc(l), new $n(t);
  }, Ou.version = "19.2.8", Ou;
}
var Gr;
function jy() {
  if (Gr) return pf.exports;
  Gr = 1;
  function o() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(o);
      } catch (E) {
        console.error(E);
      }
  }
  return o(), pf.exports = Ty(), pf.exports;
}
var Ey = jy();
class xy extends Error {
  constructor(E, _, m) {
    super(E), this.status = _, this.payload = m;
  }
  status;
  payload;
}
const Ny = 15e3;
async function Ft(o, E = {}) {
  const _ = new Headers(E.headers);
  E.body && !_.has("content-type") && _.set("content-type", "application/json");
  const m = new AbortController();
  let C = !1;
  const D = E.signal, Q = () => m.abort();
  D && (D.aborted ? Q() : D.addEventListener("abort", Q, { once: !0 }));
  const W = setTimeout(() => {
    C = !0, m.abort();
  }, Ny);
  try {
    const M = await fetch(o, { ...E, headers: _, signal: m.signal, credentials: "same-origin" });
    let S = {};
    try {
      S = await M.json();
    } catch {
    }
    if (!M.ok) {
      const O = S && typeof S == "object" ? S : {}, T = typeof O.error == "string" ? O.error : typeof O.message == "string" ? O.message : `Request failed (${M.status})`;
      throw new xy(T, M.status, S);
    }
    return S;
  } catch (M) {
    throw C ? new Error("Forge Runtime 暂时没有响应。请在连接恢复后重试。") : M;
  } finally {
    clearTimeout(W), D?.removeEventListener("abort", Q);
  }
}
const It = {
  commandCenter: () => Ft("/api/console/command-center"),
  work: () => Ft("/api/console/requirements"),
  workPortfolio: () => Ft("/api/console/work-portfolio"),
  automations: () => Ft("/api/console/automations"),
  connector: () => Ft("/api/console/connector/status"),
  advanced: () => Ft("/api/console/advanced"),
  automationAction: (o, E, _, m) => Ft(`/api/console/automations/${encodeURIComponent(o)}/${encodeURIComponent(E)}/${encodeURIComponent(_)}/${encodeURIComponent(m)}`, { method: "POST", body: "{}" }),
  registerRepository: (o, E) => Ft("/api/repositories/register", { method: "POST", body: JSON.stringify({ path: o, displayName: E }) }),
  removeRepository: (o) => Ft(`/api/repositories/${encodeURIComponent(o)}/remove`, { method: "POST", body: "{}" })
}, Kr = [
  { id: "overview", label: "Overview", group: "daily" },
  { id: "automations", label: "Automations", group: "daily" },
  { id: "work", label: "Work", group: "daily" },
  { id: "capabilities", label: "Capabilities", group: "manage" },
  { id: "repositories", label: "Repositories", group: "manage" },
  { id: "system", label: "System", group: "system" }
];
function Lr() {
  const o = location.hash.replace(/^#\/?/, "").split("/")[0];
  return Kr.some((E) => E.id === o) ? o : "overview";
}
function Ee({ children: o, ...E }) {
  return /* @__PURE__ */ f.jsx("svg", { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: "1.55", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", ...E, children: o });
}
const Oy = (o) => /* @__PURE__ */ f.jsx(Ee, { ...o, children: /* @__PURE__ */ f.jsx("path", { d: "M3 9.2 10 3l7 6.2v7.1a.7.7 0 0 1-.7.7h-4.2v-5H7.9v5H3.7a.7.7 0 0 1-.7-.7z" }) }), _y = (o) => /* @__PURE__ */ f.jsxs(Ee, { ...o, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4.2 6.3A6.5 6.5 0 0 1 16 7" }),
  /* @__PURE__ */ f.jsx("path", { d: "m16 3 .4 4.4-4.4.4" }),
  /* @__PURE__ */ f.jsx("path", { d: "M15.8 13.7A6.5 6.5 0 0 1 4 13" }),
  /* @__PURE__ */ f.jsx("path", { d: "m4 17-.4-4.4 4.4-.4" })
] }), My = (o) => /* @__PURE__ */ f.jsxs(Ee, { ...o, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4 5.2h12v10.6H4z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M7 5.2V3.6h6v1.6M7 9h6M7 12h4" })
] }), Dy = (o) => /* @__PURE__ */ f.jsx(Ee, { ...o, children: /* @__PURE__ */ f.jsx("path", { d: "m10 2.8 2 4 4.4.7-3.2 3.1.8 4.4-4-2.1L6 15l.8-4.4-3.2-3.1L8 6.8z" }) }), Uy = (o) => /* @__PURE__ */ f.jsxs(Ee, { ...o, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4 3.5h5l1.4 2H16v11H4z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M4 8h12" })
] }), Ry = (o) => /* @__PURE__ */ f.jsxs(Ee, { ...o, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M3.2 4.5h13.6v9.2H3.2z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M7 17h6M10 13.7V17" })
] }), Cy = (o) => /* @__PURE__ */ f.jsxs(Ee, { ...o, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M15.5 6A6 6 0 1 0 16 12" }),
  /* @__PURE__ */ f.jsx("path", { d: "m15.5 2.8.3 3.7-3.7.2" })
] }), Hy = (o) => /* @__PURE__ */ f.jsxs(Ee, { ...o, children: [
  /* @__PURE__ */ f.jsx("circle", { cx: "8.8", cy: "8.8", r: "5" }),
  /* @__PURE__ */ f.jsx("path", { d: "m12.5 12.5 4 4" })
] }), qy = { overview: Oy, automations: _y, work: My, capabilities: Dy, repositories: Uy, system: Ry }, By = { daily: "Workspace", manage: "Configure", system: "System" };
function Yy({ route: o }) {
  let E = "";
  return /* @__PURE__ */ f.jsxs("aside", { className: "sidebar", children: [
    /* @__PURE__ */ f.jsxs("div", { className: "brand", children: [
      /* @__PURE__ */ f.jsx("span", { className: "brand-mark", children: "F" }),
      /* @__PURE__ */ f.jsxs("div", { children: [
        /* @__PURE__ */ f.jsx("strong", { children: "Forge" }),
        /* @__PURE__ */ f.jsx("small", { children: "Utility Console" })
      ] })
    ] }),
    /* @__PURE__ */ f.jsx("nav", { children: Kr.map((_) => {
      const m = qy[_.id], C = _.group !== E;
      return E = _.group, /* @__PURE__ */ f.jsxs("div", { className: C ? "nav-group-start" : "nav-item", children: [
        C && /* @__PURE__ */ f.jsx("div", { className: "nav-group-label", children: By[_.group] }),
        /* @__PURE__ */ f.jsxs("a", { href: `#/${_.id}`, className: o === _.id ? "active" : "", children: [
          /* @__PURE__ */ f.jsx(m, {}),
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
function Gy({ route: o, children: E }) {
  return /* @__PURE__ */ f.jsxs("div", { className: "app-shell", children: [
    /* @__PURE__ */ f.jsx(Yy, { route: o }),
    /* @__PURE__ */ f.jsx("main", { className: "workspace", children: E })
  ] });
}
function Je(o) {
  if (!o) return "—";
  const E = new Date(o);
  return Number.isNaN(E.getTime()) ? o : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: !1 }).format(E);
}
function Pt(o, E = 86) {
  const _ = (o ?? "").trim();
  return _.length > E ? `${_.slice(0, E - 1)}…` : _;
}
function Ua(o, E = "—") {
  return typeof o == "string" && o.trim() ? o : String(o ?? E);
}
function xf(o) {
  return JSON.stringify(o ?? {}, null, 2);
}
function Ra({ eyebrow: o, title: E, description: _, refreshedAt: m, busy: C, onRefresh: D, actions: Q }) {
  return /* @__PURE__ */ f.jsxs("header", { className: "command-bar", children: [
    /* @__PURE__ */ f.jsxs("div", { className: "command-title", children: [
      o && /* @__PURE__ */ f.jsx("div", { className: "eyebrow", children: o }),
      /* @__PURE__ */ f.jsx("h1", { children: E }),
      /* @__PURE__ */ f.jsx("p", { children: _ })
    ] }),
    /* @__PURE__ */ f.jsxs("div", { className: "command-actions", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "command-meta", children: [
        /* @__PURE__ */ f.jsx("span", { children: "Last synced" }),
        /* @__PURE__ */ f.jsx("strong", { children: Je(m) })
      ] }),
      /* @__PURE__ */ f.jsx("button", { className: "icon-button", onClick: D, disabled: C, title: "Refresh", children: /* @__PURE__ */ f.jsx(Cy, {}) }),
      Q,
      /* @__PURE__ */ f.jsx("a", { className: "button ghost-link", href: "https://chatgpt.com", target: "_blank", rel: "noreferrer", children: "Open ChatGPT ↗" })
    ] })
  ] });
}
function Ly(o) {
  const E = (o ?? "").toLowerCase();
  return /ready|enabled|healthy|success|done|completed|active/.test(E) ? "success" : /attention|blocked|error|fail|danger/.test(E) ? "danger" : /pause|waiting|warn|degrad|stale|planned/.test(E) ? "warning" : /info|running/.test(E) ? "info" : "neutral";
}
function dt({ label: o, tone: E }) {
  const _ = E && ["success", "warning", "danger", "info", "neutral"].includes(E) ? E : Ly(E ?? o);
  return /* @__PURE__ */ f.jsxs("span", { className: "status-text", children: [
    /* @__PURE__ */ f.jsx("i", { className: `status-dot ${_}` }),
    o
  ] });
}
function Qr({ title: o, meta: E, actions: _ }) {
  return /* @__PURE__ */ f.jsxs("div", { className: "section-header", children: [
    /* @__PURE__ */ f.jsxs("div", { children: [
      /* @__PURE__ */ f.jsx("h2", { children: o }),
      E && /* @__PURE__ */ f.jsx("span", { children: E })
    ] }),
    _ && /* @__PURE__ */ f.jsx("div", { children: _ })
  ] });
}
function Qy(o) {
  return o.advanced?.status ?? "";
}
function Xy(o) {
  return ["blocked", "failed"].includes(Qy(o));
}
function jf(o) {
  return `${String(o.title ?? "")}:${String(o.reason ?? "")}`;
}
function Zy(o) {
  const E = `${o.readinessLabel ?? ""} ${o.statusLabel ?? ""}`;
  return /error|failed|blocked|unavailable|degraded|warning|attention/i.test(E);
}
function Vy({ data: o, busy: E, onRefresh: _ }) {
  const m = o.commandCenter, C = o.workPortfolio, D = o.automations.summary, Q = m.pluginSummary ?? {}, W = m.repositories ?? [], M = m.readiness ?? {}, S = Q.total ?? (m.plugins ?? []).length, O = W.filter(Zy).length, T = String(M.state ?? M.status ?? "ready"), q = /error|failed|blocked|unavailable|degraded|warning|attention/i.test(T), N = String(M.label ?? M.headline ?? (q ? "Needs attention" : "Ready")), El = C.items.filter(Xy).slice(0, 4), xl = [...m.handoffs ?? []].filter((X, w, Cl) => Cl.findIndex((Jl) => jf(Jl) === jf(X)) === w), Nl = [
    ...q ? [{
      key: "runtime",
      source: "System",
      title: N,
      summary: Pt(String(M.explanation ?? M.summary ?? "Inspect Runtime status."), 112),
      statusLabel: "Inspect",
      tone: T,
      href: "#/system"
    }] : [],
    ...El.map((X) => ({
      key: `work:${X.id}`,
      source: `Work · ${X.repositoryName}`,
      title: X.title,
      summary: Pt(X.latestSummary || X.nextAction || X.objective, 112),
      statusLabel: X.statusLabel,
      tone: X.tone ?? "warning",
      href: "#/work"
    })),
    ...xl.slice(0, 2).map((X, w) => ({
      key: `handoff:${w}:${jf(X)}`,
      source: "Decision",
      title: String(X.title ?? "Needs review"),
      summary: Pt(String(X.reason ?? X.summary ?? "Review in ChatGPT."), 112),
      statusLabel: String(X.statusLabel ?? "Review"),
      tone: String(X.tone ?? "warning"),
      href: "#/work"
    })),
    ...(D.needsAttention ?? 0) > 0 ? [{
      key: "automations",
      source: "Automations",
      title: `${D.needsAttention} automation${D.needsAttention === 1 ? "" : "s"} need attention`,
      summary: "Inspect configured schedules.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/automations"
    }] : [],
    ...(Q.needsAttention ?? 0) > 0 ? [{
      key: "capabilities",
      source: "Capabilities",
      title: `${Q.needsAttention} ${Q.needsAttention === 1 ? "capability" : "capabilities"} need attention`,
      summary: "Inspect configured capability readiness.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/capabilities"
    }] : [],
    ...O > 0 ? [{
      key: "repositories",
      source: "Repositories",
      title: `${O} ${O === 1 ? "repository" : "repositories"} need attention`,
      summary: "Inspect repository registration and readiness.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/repositories"
    }] : []
  ].filter((X, w, Cl) => Cl.findIndex((Jl) => Jl.key === X.key) === w).slice(0, 6), cl = C.summary.needsAttention ? `${C.summary.open} open · ${C.summary.needsAttention} need attention` : `${C.summary.open} open · no attention needed`, tl = D.needsAttention ? `${D.enabled} 个运行中 · ${D.needsAttention} 个需要处理` : D.paused ? `${D.enabled} 个运行中 · ${D.paused} 个已暂停` : (D.completed ?? 0) > 0 ? `${D.enabled} 个运行中 · ${D.completed} 个已完成` : `${D.enabled} 个运行中 · 状态正常`, Rl = (Q.needsAttention ?? 0) > 0 ? `${Q.ready ?? 0} / ${S} ready · ${Q.needsAttention} need attention` : `${Q.ready ?? 0} / ${S} ready`, Kl = O ? `${W.length} registered · ${O} need attention` : `${W.length} registered`, rt = [
    { key: "work", label: "Work", summary: cl, href: "#/work", statusLabel: C.summary.needsAttention ? "Attention" : void 0, tone: C.summary.needsAttention ? "warning" : void 0 },
    { key: "automations", label: "Automations", summary: tl, href: "#/automations", statusLabel: D.needsAttention ? "Attention" : void 0, tone: D.needsAttention ? "warning" : void 0 },
    { key: "capabilities", label: "Capabilities", summary: Rl, href: "#/capabilities", statusLabel: (Q.needsAttention ?? 0) > 0 ? "Attention" : void 0, tone: (Q.needsAttention ?? 0) > 0 ? "warning" : void 0 },
    { key: "repositories", label: "Repositories", summary: Kl, href: "#/repositories", statusLabel: O ? "Attention" : void 0, tone: O ? "warning" : void 0 },
    { key: "system", label: "System", summary: q ? N : "Runtime ready", href: "#/system", statusLabel: q ? "Attention" : "Ready", tone: q ? T : "success" }
  ];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx(
      Ra,
      {
        eyebrow: "FORGE CONTROL PLANE",
        title: "Overview",
        description: "需要处理的事项，以及 Forge 各工作区当前状态。",
        refreshedAt: o.generatedAt,
        busy: E,
        onRefresh: _
      }
    ),
    /* @__PURE__ */ f.jsxs("div", { className: "overview-home", children: [
      /* @__PURE__ */ f.jsxs("section", { className: "page-section overview-attention-section", children: [
        /* @__PURE__ */ f.jsx(Qr, { title: "Needs attention", meta: Nl.length ? `${Nl.length} items` : "All clear" }),
        Nl.length ? /* @__PURE__ */ f.jsx("div", { className: "overview-attention-list", children: Nl.map((X) => /* @__PURE__ */ f.jsxs("a", { className: "overview-attention-row", href: X.href, children: [
          /* @__PURE__ */ f.jsx("div", { className: "overview-attention-source", children: X.source }),
          /* @__PURE__ */ f.jsxs("div", { className: "overview-attention-copy", children: [
            /* @__PURE__ */ f.jsx("strong", { children: Pt(X.title, 82) }),
            /* @__PURE__ */ f.jsx("p", { children: X.summary })
          ] }),
          /* @__PURE__ */ f.jsx(dt, { label: X.statusLabel, tone: X.tone }),
          /* @__PURE__ */ f.jsx("span", { className: "overview-row-arrow", "aria-hidden": "true", children: "→" })
        ] }, X.key)) }) : /* @__PURE__ */ f.jsxs("div", { className: "overview-clear-state", children: [
          /* @__PURE__ */ f.jsx(dt, { label: "No action needed", tone: "success" }),
          /* @__PURE__ */ f.jsx("span", { children: "Forge is operating normally." })
        ] })
      ] }),
      /* @__PURE__ */ f.jsxs("section", { className: "page-section overview-workspace-section", children: [
        /* @__PURE__ */ f.jsx(Qr, { title: "Workspace", meta: "Current state" }),
        /* @__PURE__ */ f.jsx("div", { className: "overview-workspace-list", children: rt.map((X) => /* @__PURE__ */ f.jsxs("a", { className: "overview-workspace-row", href: X.href, children: [
          /* @__PURE__ */ f.jsx("strong", { children: X.label }),
          /* @__PURE__ */ f.jsx("span", { children: X.summary }),
          X.statusLabel && /* @__PURE__ */ f.jsx(dt, { label: X.statusLabel, tone: X.tone }),
          /* @__PURE__ */ f.jsx("span", { className: "overview-row-arrow", "aria-hidden": "true", children: "→" })
        ] }, X.key)) })
      ] })
    ] })
  ] });
}
function Nf({ items: o, value: E, onChange: _ }) {
  return /* @__PURE__ */ f.jsx("div", { className: "segmented", role: "tablist", children: o.map((m) => /* @__PURE__ */ f.jsxs("button", { role: "tab", "aria-selected": E === m.id, className: E === m.id ? "selected" : "", onClick: () => _(m.id), children: [
    m.label,
    m.count !== void 0 && /* @__PURE__ */ f.jsx("span", { children: m.count })
  ] }, m.id)) });
}
function In({ title: o, subtitle: E, actions: _, children: m, empty: C }) {
  return /* @__PURE__ */ f.jsx("aside", { className: "detail-pane", children: o ? /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsxs("div", { className: "detail-head", children: [
      /* @__PURE__ */ f.jsxs("div", { children: [
        /* @__PURE__ */ f.jsx("div", { className: "eyebrow", children: "DETAIL" }),
        /* @__PURE__ */ f.jsx("h2", { children: o }),
        E && /* @__PURE__ */ f.jsx("p", { children: E })
      ] }),
      _ && /* @__PURE__ */ f.jsx("div", { className: "detail-actions", children: _ })
    ] }),
    /* @__PURE__ */ f.jsx("div", { className: "detail-body", children: m })
  ] }) : /* @__PURE__ */ f.jsx("div", { className: "detail-empty", children: C ?? "选择一项查看详细配置" }) });
}
function Mu({ items: o }) {
  return /* @__PURE__ */ f.jsx("dl", { className: "definition-list", children: o.map(([E, _]) => /* @__PURE__ */ f.jsxs("div", { children: [
    /* @__PURE__ */ f.jsx("dt", { children: E }),
    /* @__PURE__ */ f.jsx("dd", { children: _ })
  ] }, E)) });
}
function Fn({ children: o, className: E = "", ..._ }) {
  return /* @__PURE__ */ f.jsx("button", { className: `button ${E}`.trim(), ..._, children: o });
}
function Xr(o) {
  return o === "enabled" ? "运行中" : o === "paused" ? "已暂停" : o === "attention" ? "需要处理" : o === "completed" ? "已完成" : "已停用";
}
function Zr(o) {
  return o === "enabled" ? "success" : o === "attention" ? "danger" : o === "paused" ? "warning" : o === "completed" ? "success" : "neutral";
}
function Ky(o) {
  if (o === "baseline") return "已建立基线";
  if (o === "unchanged") return "无变化";
  if (o === "changed") return "检测到变化";
  if (o === "keepalive") return "登录保持正常";
  if (o === "auth_required") return "需要重新登录";
}
function Jy(o) {
  return o === "high" ? "高" : o === "medium" ? "中" : o === "xhigh" ? "超高" : o ?? "—";
}
function wy(o) {
  return o === "auto" ? "自动 · 同一任务优先复用" : o === "reuse" ? "始终复用已绑定会话" : o === "new" ? "每次新开标签页" : o ?? "—";
}
function $y(o) {
  return o.agentModel ? [
    ["执行模型", `${o.agentModel} · ${Jy(o.reasoningLevel)}推理`],
    ["标签页策略", wy(o.tabPolicy)]
  ] : [];
}
function Wy(o, E = !1) {
  return E ? "不会再次触发" : o ? Number.isFinite(Date.parse(o)) ? Je(o) : o : "等待下一次计划";
}
function ky(o) {
  return o === "green" ? "success" : o === "amber" ? "warning" : o === "red" ? "danger" : o === "blue" ? "info" : "neutral";
}
function Fy({ items: o }) {
  return o.length ? /* @__PURE__ */ f.jsx("div", { className: "automation-history", children: o.map((E) => /* @__PURE__ */ f.jsxs("div", { className: "automation-history-row", children: [
    /* @__PURE__ */ f.jsx("div", { className: `automation-history-mark ${E.tone}` }),
    /* @__PURE__ */ f.jsxs("div", { className: "automation-history-copy", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "automation-history-top", children: [
        /* @__PURE__ */ f.jsx(dt, { label: E.result, tone: ky(E.tone) }),
        /* @__PURE__ */ f.jsx("time", { children: Je(E.at) })
      ] }),
      E.reason && /* @__PURE__ */ f.jsx("p", { children: E.reason }),
      E.trigger && /* @__PURE__ */ f.jsxs("small", { children: [
        E.trigger,
        "触发"
      ] })
    ] })
  ] }, E.id)) }) : /* @__PURE__ */ f.jsx("div", { className: "automation-history-empty", children: "还没有执行记录。" });
}
function Iy({ data: o, busy: E, onRefresh: _, onAction: m }) {
  const C = o.automations.automations, [D, Q] = bl.useState("enabled"), W = bl.useMemo(() => C.filter((N) => D === "all" || (D === "paused" ? N.status === "paused" || N.status === "disabled" : N.status === D)), [C, D]), [M, S] = bl.useState(), O = (N) => `${N.source}:${N.repoId}:${N.id}`, T = W.find((N) => O(N) === M) ?? W[0], q = T ? Ky(T.observationStatus) : void 0;
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx(Ra, { eyebrow: "AUTOMATION", title: "自动任务", description: "查看哪些任务正在运行、何时再次执行、是否需要处理，以及最近实际发生了什么。", refreshedAt: o.automations.generatedAt, busy: E, onRefresh: _ }),
    /* @__PURE__ */ f.jsx("div", { className: "toolbar automation-toolbar", children: /* @__PURE__ */ f.jsx(Nf, { value: D, onChange: Q, items: [
      { id: "enabled", label: "运行中", count: C.filter((N) => N.status === "enabled").length },
      { id: "paused", label: "已暂停", count: C.filter((N) => N.status === "paused" || N.status === "disabled").length },
      { id: "attention", label: "需要处理", count: C.filter((N) => N.status === "attention").length },
      { id: "completed", label: "已完成", count: C.filter((N) => N.status === "completed").length },
      { id: "all", label: "全部", count: C.length }
    ] }) }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace automation-layout", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "table-wrap", children: [
        /* @__PURE__ */ f.jsxs("table", { className: "data-table automation-table", children: [
          /* @__PURE__ */ f.jsx("thead", { children: /* @__PURE__ */ f.jsxs("tr", { children: [
            /* @__PURE__ */ f.jsx("th", { children: "自动任务" }),
            /* @__PURE__ */ f.jsx("th", { children: "触发" }),
            /* @__PURE__ */ f.jsx("th", { children: "行为" }),
            /* @__PURE__ */ f.jsx("th", { children: "状态" }),
            /* @__PURE__ */ f.jsx("th", { children: "最近结果" })
          ] }) }),
          /* @__PURE__ */ f.jsx("tbody", { children: W.map((N) => /* @__PURE__ */ f.jsxs("tr", { className: T && O(T) === O(N) ? "selected" : "", onClick: () => S(O(N)), children: [
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx("strong", { children: N.name }),
              /* @__PURE__ */ f.jsxs("small", { children: [
                N.repositoryName,
                " · ",
                N.modeLabel
              ] })
            ] }),
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx("span", { children: N.schedule }),
              /* @__PURE__ */ f.jsx("small", { children: N.timezone ?? "本地时区" })
            ] }),
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx("span", { children: N.delivery ?? "本地执行" }),
              N.targetLabel && /* @__PURE__ */ f.jsx("small", { children: N.targetLabel })
            ] }),
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx(dt, { label: Xr(N.status), tone: Zr(N.status) }),
              N.live !== void 0 && /* @__PURE__ */ f.jsx("small", { children: N.live ? "实际执行" : "仅预演" })
            ] }),
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx("span", { children: Pt(N.lastResult, 26) || "—" }),
              /* @__PURE__ */ f.jsx("small", { children: Je(N.lastRunAt) })
            ] })
          ] }, O(N))) })
        ] }),
        !W.length && /* @__PURE__ */ f.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Automation。" })
      ] }),
      /* @__PURE__ */ f.jsx(In, { title: T?.name, subtitle: T?.summary, empty: "选择一个 Automation 查看配置与执行历史", children: T && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsxs("div", { className: "automation-detail-status", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("span", { className: "eyebrow", children: "当前状态" }),
            /* @__PURE__ */ f.jsx(dt, { label: Xr(T.status), tone: Zr(T.status) })
          ] }),
          /* @__PURE__ */ f.jsxs("div", { className: "automation-result", children: [
            /* @__PURE__ */ f.jsx("strong", { children: T.lastResult ?? "尚未执行" }),
            /* @__PURE__ */ f.jsx("small", { children: Je(T.observationAt ?? T.lastRunAt) })
          ] })
        ] }),
        /* @__PURE__ */ f.jsx(Mu, { items: [
          ["类型", T.modeLabel],
          ["触发计划", `${T.schedule}${T.timezone ? ` · ${T.timezone}` : ""}`],
          ["触发后的行为", T.delivery ?? "本地执行"],
          ["下次执行", Wy(T.nextRunHint, T.status === "completed")],
          ["观察目标", T.targetLabel ?? "—"],
          ["观察状态", q ?? "—"],
          ["关联工作", T.boundWorkObjective ? Pt(T.boundWorkObjective, 96) : T.boundWorkId ?? "—"],
          ["执行方式", T.live === void 0 ? "—" : T.live ? "实际执行" : "仅预演"],
          ...$y(T)
        ] }),
        T.attentionMessage && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout danger", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "需要处理" }),
          /* @__PURE__ */ f.jsx("p", { children: T.attentionMessage })
        ] }),
        !T.attentionMessage && T.pausedReason && /* @__PURE__ */ f.jsxs("div", { className: `detail-callout ${T.status === "completed" ? "success" : "warning"}`, children: [
          /* @__PURE__ */ f.jsx("strong", { children: T.status === "completed" ? "任务已完成" : "暂停原因" }),
          /* @__PURE__ */ f.jsx("p", { children: T.pausedReason })
        ] }),
        /* @__PURE__ */ f.jsx("div", { className: "detail-button-row", children: T.actions.map((N) => /* @__PURE__ */ f.jsx(Fn, { disabled: E, className: N === "pause" ? "danger-text" : "", onClick: () => {
          m(T, N);
        }, children: N === "run" ? "立即运行" : N === "pause" ? "暂停任务" : "恢复任务" }, N)) }),
        /* @__PURE__ */ f.jsxs("div", { className: "automation-section-head", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("span", { className: "eyebrow", children: "执行记录" }),
            /* @__PURE__ */ f.jsx("h3", { children: "最近执行" })
          ] }),
          /* @__PURE__ */ f.jsxs("span", { children: [
            T.history.length,
            " 条"
          ] })
        ] }),
        /* @__PURE__ */ f.jsx(Fy, { items: T.history }),
        /* @__PURE__ */ f.jsxs("details", { className: "advanced automation-advanced", children: [
          /* @__PURE__ */ f.jsx("summary", { children: "技术信息" }),
          /* @__PURE__ */ f.jsx("pre", { children: JSON.stringify({ scheduleId: T.source === "schedule" ? T.id : void 0, workId: T.boundWorkId, source: T.source, next: T.nextRunHint, failureCount: T.failureCount, policy: T.policySummary }, null, 2) })
        ] }),
        /* @__PURE__ */ f.jsx("p", { className: "detail-note", children: "这里只展示配置、状态与执行摘要；邮件正文、浏览器 Cookie、登录凭据和 continuation prompt 不会复制到控制台。" })
      ] }) })
    ] })
  ] });
}
function Py(o) {
  return o.advanced?.status ?? "";
}
function kn(o, E) {
  const _ = Py(o);
  return E === "all" ? !0 : E === "attention" ? _ === "blocked" || _ === "failed" : E === "completed" ? _ === "completed" || _ === "cancelled" : _ === "open" || _ === "running" || _ === "ready";
}
function lv({ data: o, busy: E, onRefresh: _ }) {
  const m = o.workPortfolio, C = m.items ?? [], [D, Q] = bl.useState("open"), [W, M] = bl.useState("all"), [S, O] = bl.useState(), T = bl.useMemo(() => C.filter((N) => kn(N, D) && (W === "all" || N.repoId === W)), [C, D, W]), q = T.find((N) => N.id === S) ?? T[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx(Ra, { eyebrow: "EXECUTION WORK", title: "Work", description: "查看所有已注册仓库的持久 Work；仓库是归属维度，默认聚合展示。", refreshedAt: m.generatedAt, busy: E, onRefresh: _ }),
    /* @__PURE__ */ f.jsxs("div", { className: "toolbar work-toolbar", children: [
      /* @__PURE__ */ f.jsx(Nf, { value: D, onChange: Q, items: [{ id: "open", label: "Open", count: C.filter((N) => kn(N, "open")).length }, { id: "attention", label: "Needs attention", count: C.filter((N) => kn(N, "attention")).length }, { id: "completed", label: "Completed", count: C.filter((N) => kn(N, "completed")).length }, { id: "all", label: "All", count: C.length }] }),
      /* @__PURE__ */ f.jsxs("label", { className: "repository-filter", children: [
        /* @__PURE__ */ f.jsx("span", { children: "Repository" }),
        /* @__PURE__ */ f.jsxs("select", { value: W, onChange: (N) => {
          M(N.target.value), O(void 0);
        }, children: [
          /* @__PURE__ */ f.jsx("option", { value: "all", children: "All repositories" }),
          m.repositories.map((N) => /* @__PURE__ */ f.jsx("option", { value: N.repoId, children: N.repositoryName }, N.repoId))
        ] })
      ] })
    ] }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "scan-list", children: [
        T.map((N) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row work-row ${q?.id === N.id ? "selected" : ""}`, onClick: () => O(N.id), children: [
          /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
            /* @__PURE__ */ f.jsx("span", { className: "row-eyebrow", children: N.repositoryName }),
            /* @__PURE__ */ f.jsx("strong", { children: N.title }),
            /* @__PURE__ */ f.jsx("p", { children: Pt(N.latestSummary || N.objective, 108) })
          ] }),
          /* @__PURE__ */ f.jsxs("div", { className: "scan-meta", children: [
            /* @__PURE__ */ f.jsx(dt, { label: N.statusLabel, tone: N.tone }),
            /* @__PURE__ */ f.jsx("time", { children: Je(N.updatedAt) })
          ] })
        ] }, N.id)),
        !T.length && /* @__PURE__ */ f.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Work。" })
      ] }),
      /* @__PURE__ */ f.jsx(In, { title: q?.title, subtitle: q?.objective, empty: "选择一个 Work 查看完整上下文", children: q && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Mu, { items: [["Repository", q.repositoryName], ["Status", /* @__PURE__ */ f.jsx(dt, { label: q.statusLabel, tone: q.tone })], ["Updated", Je(q.updatedAt)], ["Work id", /* @__PURE__ */ f.jsx("code", { children: q.id })]] }),
        q.latestSummary && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Latest" }),
          /* @__PURE__ */ f.jsx("p", { children: q.latestSummary })
        ] }),
        /* @__PURE__ */ f.jsx("p", { className: "detail-note", children: "这里聚合所有仓库的持久 Work。具体执行、检查和继续操作仍由 ChatGPT 主控。" })
      ] }) })
    ] })
  ] });
}
function _u(o) {
  const E = `${o.name} ${o.provider} ${(o.capabilityLabels ?? []).join(" ")}`.toLowerCase();
  return /gmail|calendar|github|google task|notion/.test(E) ? "services" : /browser|desktop|ios|repository|codegraph|local/.test(E) ? "execution" : "extensions";
}
function tv({ data: o, busy: E, onRefresh: _ }) {
  const m = o.commandCenter.plugins ?? [], [C, D] = bl.useState("all"), [Q, W] = bl.useState(), M = bl.useMemo(() => m.filter((O) => C === "all" || _u(O) === C), [m, C]), S = M.find((O) => O.id === Q) ?? M[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx(Ra, { eyebrow: "CAPABILITY CATALOG", title: "Capabilities", description: "从“Forge 能做什么”查看扩展、服务与执行能力，而不是浏览 MCP tool 清单。", refreshedAt: o.generatedAt, busy: E, onRefresh: _ }),
    /* @__PURE__ */ f.jsx("div", { className: "toolbar", children: /* @__PURE__ */ f.jsx(Nf, { value: C, onChange: D, items: [
      { id: "all", label: "All", count: m.length },
      { id: "extensions", label: "Extensions", count: m.filter((O) => _u(O) === "extensions").length },
      { id: "services", label: "Services", count: m.filter((O) => _u(O) === "services").length },
      { id: "execution", label: "Execution", count: m.filter((O) => _u(O) === "execution").length }
    ] }) }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ f.jsx("div", { className: "scan-list", children: M.map((O) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row ${S?.id === O.id ? "selected" : ""}`, onClick: () => W(O.id), children: [
        /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ f.jsx("span", { className: "row-eyebrow", children: _u(O).toUpperCase() }),
          /* @__PURE__ */ f.jsx("strong", { children: O.name }),
          /* @__PURE__ */ f.jsx("p", { children: Pt(O.description, 100) })
        ] }),
        /* @__PURE__ */ f.jsx(dt, { label: O.statusLabel ?? O.status ?? "Unknown", tone: O.status ?? O.tone })
      ] }, O.id)) }),
      /* @__PURE__ */ f.jsx(In, { title: S?.name, subtitle: S?.description, children: S && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Mu, { items: [["Status", /* @__PURE__ */ f.jsx(dt, { label: S.statusLabel ?? S.status ?? "Unknown", tone: S.status ?? S.tone })], ["Provider", S.provider ?? "—"], ["Health", S.healthLabel ?? "—"], ["Lifecycle", S.lifecycleLabel ?? "—"]] }),
        S.nextStep && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Next step" }),
          /* @__PURE__ */ f.jsx("p", { children: S.nextStep })
        ] }),
        (S.capabilityLabels ?? []).length > 0 && /* @__PURE__ */ f.jsx("div", { className: "capability-lines", children: S.capabilityLabels.map((O) => /* @__PURE__ */ f.jsx("span", { children: O }, O)) }),
        (S.warnings ?? []).map((O) => /* @__PURE__ */ f.jsx("div", { className: "detail-callout warning", children: O }, O)),
        /* @__PURE__ */ f.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced · actions & protocol" }),
          /* @__PURE__ */ f.jsx("pre", { children: xf({ actions: S.actions, advanced: S.advanced }) })
        ] })
      ] }) })
    ] })
  ] });
}
function ev({ value: o, onChange: E, placeholder: _ = "Search…" }) {
  return /* @__PURE__ */ f.jsxs("label", { className: "search-field", children: [
    /* @__PURE__ */ f.jsx(Hy, {}),
    /* @__PURE__ */ f.jsx("input", { value: o, onChange: (m) => E(m.target.value), placeholder: _ })
  ] });
}
function av({ data: o, busy: E, onRefresh: _, onRegister: m, onRemove: C }) {
  const D = o.commandCenter.repositories ?? [], [Q, W] = bl.useState(""), [M, S] = bl.useState(), [O, T] = bl.useState(""), [q, N] = bl.useState(""), [El, xl] = bl.useState(!1), Nl = bl.useMemo(() => D.filter((tl) => `${tl.name} ${tl.path} ${tl.branchLabel}`.toLowerCase().includes(Q.toLowerCase())), [D, Q]), cl = Nl.find((tl) => tl.id === M) ?? Nl[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx(Ra, { eyebrow: "CONTROLLER REGISTRY", title: "Repositories", description: "查看和管理 Forge 的持久化仓库边界；临时目录不需要出现在这里。", refreshedAt: o.generatedAt, busy: E, onRefresh: _, actions: /* @__PURE__ */ f.jsx(Fn, { onClick: () => xl((tl) => !tl), "aria-expanded": El, children: El ? "Cancel" : "Add repository" }) }),
    /* @__PURE__ */ f.jsxs("div", { className: "repository-tools", children: [
      /* @__PURE__ */ f.jsx(ev, { value: Q, onChange: W, placeholder: "Search repositories…" }),
      /* @__PURE__ */ f.jsx("span", { className: "repository-count", children: Nl.length === D.length ? `${D.length} registered` : `${Nl.length} of ${D.length}` })
    ] }),
    El && /* @__PURE__ */ f.jsxs("form", { className: "repository-add-panel", onSubmit: (tl) => {
      tl.preventDefault(), O.trim() && m(O.trim(), q.trim() || void 0).then(() => {
        T(""), N(""), xl(!1);
      });
    }, children: [
      /* @__PURE__ */ f.jsxs("div", { className: "repository-add-fields", children: [
        /* @__PURE__ */ f.jsxs("label", { children: [
          /* @__PURE__ */ f.jsx("span", { children: "Local path" }),
          /* @__PURE__ */ f.jsx("input", { autoFocus: !0, value: O, onChange: (tl) => T(tl.target.value), placeholder: "/absolute/path" })
        ] }),
        /* @__PURE__ */ f.jsxs("label", { children: [
          /* @__PURE__ */ f.jsx("span", { children: "Display name" }),
          /* @__PURE__ */ f.jsx("input", { value: q, onChange: (tl) => N(tl.target.value), placeholder: "Optional" })
        ] }),
        /* @__PURE__ */ f.jsx(Fn, { type: "submit", disabled: E || !O.trim(), children: "Register" })
      ] }),
      /* @__PURE__ */ f.jsx("p", { children: "只为需要持久化 Work、缓存、并发隔离或发布治理的仓库建立注册项。" })
    ] }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace repository-workspace", children: [
      /* @__PURE__ */ f.jsx("div", { className: "scan-list", children: Nl.map((tl) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row ${cl?.id === tl.id ? "selected" : ""}`, onClick: () => S(tl.id), children: [
        /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ f.jsx("strong", { children: tl.name }),
          /* @__PURE__ */ f.jsx("p", { children: Pt(tl.path, 100) })
        ] }),
        /* @__PURE__ */ f.jsxs("div", { className: "scan-meta", children: [
          /* @__PURE__ */ f.jsx(dt, { label: tl.readinessLabel ?? tl.statusLabel ?? "Registered", tone: tl.readinessLabel ?? tl.statusLabel }),
          /* @__PURE__ */ f.jsx("span", { children: tl.branchLabel ?? "—" })
        ] })
      ] }, tl.id)) }),
      /* @__PURE__ */ f.jsx(In, { title: cl?.name, subtitle: cl?.path, children: cl && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Mu, { items: [["Repository id", /* @__PURE__ */ f.jsx("code", { children: cl.id })], ["Branch", cl.branchLabel ?? "—"], ["Working tree", cl.dirtyLabel ?? "—"], ["Readiness", /* @__PURE__ */ f.jsx(dt, { label: cl.readinessLabel ?? cl.statusLabel ?? "Registered", tone: cl.readinessLabel ?? cl.statusLabel })]] }),
        /* @__PURE__ */ f.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced registry metadata" }),
          /* @__PURE__ */ f.jsx("pre", { children: xf(cl.advanced) })
        ] }),
        /* @__PURE__ */ f.jsx("div", { className: "detail-button-row", children: /* @__PURE__ */ f.jsx(Fn, { className: "danger-text", disabled: E, onClick: () => {
          C(cl.id);
        }, children: "Remove registry entry" }) })
      ] }) })
    ] })
  ] });
}
function uv({ data: o, busy: E, onRefresh: _ }) {
  const [m, C] = bl.useState(), D = o.commandCenter.readiness ?? {};
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx(Ra, { eyebrow: "MAINTENANCE", title: "System", description: "低频工程维护入口。正常使用 Forge 不需要理解这里的运行时细节。", refreshedAt: o.generatedAt, busy: E, onRefresh: _ }),
    /* @__PURE__ */ f.jsxs("div", { className: "system-layout", children: [
      /* @__PURE__ */ f.jsxs("section", { className: "system-summary", children: [
        /* @__PURE__ */ f.jsxs("div", { className: "system-posture", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("span", { className: "eyebrow", children: "SYSTEM POSTURE" }),
            /* @__PURE__ */ f.jsx("h2", { children: Ua(D.label ?? D.headline, "Controller state") }),
            /* @__PURE__ */ f.jsx("p", { children: Ua(D.explanation ?? D.summary, "Controller and connector status") })
          ] }),
          /* @__PURE__ */ f.jsx(dt, { label: Ua(D.state, "Unknown"), tone: Ua(D.state) })
        ] }),
        /* @__PURE__ */ f.jsx(Mu, { items: [["Controller", Ua(D.label ?? D.headline, "—")], ["Connector", Ua(o.connector?.status, "—")], ["Repositories", String(o.commandCenter.repositories?.length ?? 0)], ["Plugins", String(o.commandCenter.plugins?.length ?? 0)]] })
      ] }),
      /* @__PURE__ */ f.jsxs("section", { children: [
        /* @__PURE__ */ f.jsx("button", { className: "text-button", onClick: () => {
          It.advanced().then(C);
        }, children: "Load advanced diagnostics" }),
        m && /* @__PURE__ */ f.jsxs("details", { className: "advanced", open: !0, children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced diagnostics" }),
          /* @__PURE__ */ f.jsx("pre", { children: xf(m) })
        ] })
      ] })
    ] })
  ] });
}
async function Vr() {
  const [o, E, _, m, C] = await Promise.all([It.commandCenter(), It.work(), It.workPortfolio(), It.automations(), It.connector().catch(() => {
  })]);
  return { commandCenter: o, work: E, workPortfolio: _, automations: m, connector: C, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function nv() {
  const [o, E] = bl.useState(Lr()), [_, m] = bl.useState(), [C, D] = bl.useState(!1), [Q, W] = bl.useState(""), M = bl.useCallback(async () => {
    D(!0), W("");
    try {
      m(await Vr());
    } catch (q) {
      W(q instanceof Error ? q.message : String(q));
    } finally {
      D(!1);
    }
  }, []);
  bl.useEffect(() => {
    M();
    const q = () => E(Lr());
    return addEventListener("hashchange", q), () => removeEventListener("hashchange", q);
  }, [M]);
  const S = bl.useCallback(async (q) => {
    D(!0);
    try {
      await q(), m(await Vr());
    } catch (N) {
      W(N instanceof Error ? N.message : String(N));
    } finally {
      D(!1);
    }
  }, []);
  if (!_) return /* @__PURE__ */ f.jsxs("div", { className: "boot-state", children: [
    /* @__PURE__ */ f.jsx("span", { className: "brand-mark", children: "F" }),
    /* @__PURE__ */ f.jsx("strong", { children: Q ? "Forge console unavailable" : "Loading Forge…" }),
    Q && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
      /* @__PURE__ */ f.jsx("p", { children: Q }),
      /* @__PURE__ */ f.jsx("button", { className: "button", onClick: () => {
        M();
      }, children: "Retry" })
    ] })
  ] });
  const O = { data: _, busy: C, onRefresh: () => {
    M();
  } };
  let T;
  switch (o) {
    case "automations":
      T = /* @__PURE__ */ f.jsx(Iy, { ...O, onAction: (q, N) => S(() => It.automationAction(q.source, q.repoId, q.id, N)) });
      break;
    case "work":
      T = /* @__PURE__ */ f.jsx(lv, { ...O });
      break;
    case "capabilities":
      T = /* @__PURE__ */ f.jsx(tv, { ...O });
      break;
    case "repositories":
      T = /* @__PURE__ */ f.jsx(av, { ...O, onRegister: (q, N) => S(() => It.registerRepository(q, N)), onRemove: (q) => S(() => It.removeRepository(q)) });
      break;
    case "system":
      T = /* @__PURE__ */ f.jsx(uv, { ...O });
      break;
    default:
      T = /* @__PURE__ */ f.jsx(Vy, { ...O });
  }
  return /* @__PURE__ */ f.jsxs(Gy, { route: o, children: [
    Q && /* @__PURE__ */ f.jsxs("div", { className: "global-error", children: [
      /* @__PURE__ */ f.jsx("strong", { children: "Last action failed" }),
      /* @__PURE__ */ f.jsx("span", { children: Q }),
      /* @__PURE__ */ f.jsx("button", { onClick: () => W(""), children: "×" })
    ] }),
    T
  ] });
}
const Jr = document.getElementById("app");
if (!Jr) throw new Error("Forge console root missing");
Ey.createRoot(Jr).render(/* @__PURE__ */ f.jsx(bl.StrictMode, { children: /* @__PURE__ */ f.jsx(nv, {}) }));
