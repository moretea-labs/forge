var jf = { exports: {} }, _u = {};
var Ur;
function yv() {
  if (Ur) return _u;
  Ur = 1;
  var m = /* @__PURE__ */ Symbol.for("react.transitional.element"), x = /* @__PURE__ */ Symbol.for("react.fragment");
  function _(o, M, D) {
    var V = null;
    if (D !== void 0 && (V = "" + D), M.key !== void 0 && (V = "" + M.key), "key" in M) {
      D = {};
      for (var L in M)
        L !== "key" && (D[L] = M[L]);
    } else D = M;
    return M = D.ref, {
      $$typeof: m,
      type: o,
      key: V,
      ref: M !== void 0 ? M : null,
      props: D
    };
  }
  return _u.Fragment = x, _u.jsx = _, _u.jsxs = _, _u;
}
var Cr;
function gv() {
  return Cr || (Cr = 1, jf.exports = yv()), jf.exports;
}
var c = gv(), Af = { exports: {} }, J = {};
var Rr;
function Sv() {
  if (Rr) return J;
  Rr = 1;
  var m = /* @__PURE__ */ Symbol.for("react.transitional.element"), x = /* @__PURE__ */ Symbol.for("react.portal"), _ = /* @__PURE__ */ Symbol.for("react.fragment"), o = /* @__PURE__ */ Symbol.for("react.strict_mode"), M = /* @__PURE__ */ Symbol.for("react.profiler"), D = /* @__PURE__ */ Symbol.for("react.consumer"), V = /* @__PURE__ */ Symbol.for("react.context"), L = /* @__PURE__ */ Symbol.for("react.forward_ref"), O = /* @__PURE__ */ Symbol.for("react.suspense"), p = /* @__PURE__ */ Symbol.for("react.memo"), C = /* @__PURE__ */ Symbol.for("react.lazy"), A = /* @__PURE__ */ Symbol.for("react.activity"), N = Symbol.iterator;
  function G(r) {
    return r === null || typeof r != "object" ? null : (r = N && r[N] || r["@@iterator"], typeof r == "function" ? r : null);
  }
  var jl = {
    isMounted: function() {
      return !1;
    },
    enqueueForceUpdate: function() {
    },
    enqueueReplaceState: function() {
    },
    enqueueSetState: function() {
    }
  }, Al = Object.assign, Rl = {};
  function q(r, E, R) {
    this.props = r, this.context = E, this.refs = Rl, this.updater = R || jl;
  }
  q.prototype.isReactComponent = {}, q.prototype.setState = function(r, E) {
    if (typeof r != "object" && typeof r != "function" && r != null)
      throw Error(
        "takes an object of state variables to update or a function which returns an object of state variables."
      );
    this.updater.enqueueSetState(this, r, E, "setState");
  }, q.prototype.forceUpdate = function(r) {
    this.updater.enqueueForceUpdate(this, r, "forceUpdate");
  };
  function K() {
  }
  K.prototype = q.prototype;
  function El(r, E, R) {
    this.props = r, this.context = E, this.refs = Rl, this.updater = R || jl;
  }
  var Xl = El.prototype = new K();
  Xl.constructor = El, Al(Xl, q.prototype), Xl.isPureReactComponent = !0;
  var Ot = Array.isArray;
  function Kl() {
  }
  var tl = { H: null, A: null, T: null, S: null }, Jl = Object.prototype.hasOwnProperty;
  function _t(r, E, R) {
    var B = R.ref;
    return {
      $$typeof: m,
      type: r,
      key: E,
      ref: B !== void 0 ? B : null,
      props: R
    };
  }
  function We(r, E) {
    return _t(r.type, E, r.props);
  }
  function Mt(r) {
    return typeof r == "object" && r !== null && r.$$typeof === m;
  }
  function wl(r) {
    var E = { "=": "=0", ":": "=2" };
    return "$" + r.replace(/[=:]/g, function(R) {
      return E[R];
    });
  }
  var Oe = /\/+/g;
  function Ht(r, E) {
    return typeof r == "object" && r !== null && r.key != null ? wl("" + r.key) : E.toString(36);
  }
  function Tt(r) {
    switch (r.status) {
      case "fulfilled":
        return r.value;
      case "rejected":
        throw r.reason;
      default:
        switch (typeof r.status == "string" ? r.then(Kl, Kl) : (r.status = "pending", r.then(
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
  function j(r, E, R, B, w) {
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
            case C:
              return il = r._init, j(
                il(r._payload),
                E,
                R,
                B,
                w
              );
          }
      }
    if (il)
      return w = w(r), il = B === "" ? "." + Ht(r, 0) : B, Ot(w) ? (R = "", il != null && (R = il.replace(Oe, "$&/") + "/"), j(w, E, R, "", function(qa) {
        return qa;
      })) : w != null && (Mt(w) && (w = We(
        w,
        R + (w.key == null || r && r.key === w.key ? "" : ("" + w.key).replace(
          Oe,
          "$&/"
        ) + "/") + il
      )), E.push(w)), 1;
    il = 0;
    var Zl = B === "" ? "." : B + ":";
    if (Ot(r))
      for (var zl = 0; zl < r.length; zl++)
        B = r[zl], k = Zl + Ht(B, zl), il += j(
          B,
          E,
          R,
          k,
          w
        );
    else if (zl = G(r), typeof zl == "function")
      for (r = zl.call(r), zl = 0; !(B = r.next()).done; )
        B = B.value, k = Zl + Ht(B, zl++), il += j(
          B,
          E,
          R,
          k,
          w
        );
    else if (k === "object") {
      if (typeof r.then == "function")
        return j(
          Tt(r),
          E,
          R,
          B,
          w
        );
      throw E = String(r), Error(
        "Objects are not valid as a React child (found: " + (E === "[object Object]" ? "object with keys {" + Object.keys(r).join(", ") + "}" : E) + "). If you meant to render a collection of children, use an array instead."
      );
    }
    return il;
  }
  function U(r, E, R) {
    if (r == null) return r;
    var B = [], w = 0;
    return j(r, B, "", "", function(k) {
      return E.call(R, k, w++);
    }), B;
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
  var sl = typeof reportError == "function" ? reportError : function(r) {
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
  }, ml = {
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
  return J.Activity = A, J.Children = ml, J.Component = q, J.Fragment = _, J.Profiler = M, J.PureComponent = El, J.StrictMode = o, J.Suspense = O, J.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = tl, J.__COMPILER_RUNTIME = {
    __proto__: null,
    c: function(r) {
      return tl.H.useMemoCache(r);
    }
  }, J.cache = function(r) {
    return function() {
      return r.apply(null, arguments);
    };
  }, J.cacheSignal = function() {
    return null;
  }, J.cloneElement = function(r, E, R) {
    if (r == null)
      throw Error(
        "The argument must be a React element, but you passed " + r + "."
      );
    var B = Al({}, r.props), w = r.key;
    if (E != null)
      for (k in E.key !== void 0 && (w = "" + E.key), E)
        !Jl.call(E, k) || k === "key" || k === "__self" || k === "__source" || k === "ref" && E.ref === void 0 || (B[k] = E[k]);
    var k = arguments.length - 2;
    if (k === 1) B.children = R;
    else if (1 < k) {
      for (var il = Array(k), Zl = 0; Zl < k; Zl++)
        il[Zl] = arguments[Zl + 2];
      B.children = il;
    }
    return _t(r.type, w, B);
  }, J.createContext = function(r) {
    return r = {
      $$typeof: V,
      _currentValue: r,
      _currentValue2: r,
      _threadCount: 0,
      Provider: null,
      Consumer: null
    }, r.Provider = r, r.Consumer = {
      $$typeof: D,
      _context: r
    }, r;
  }, J.createElement = function(r, E, R) {
    var B, w = {}, k = null;
    if (E != null)
      for (B in E.key !== void 0 && (k = "" + E.key), E)
        Jl.call(E, B) && B !== "key" && B !== "__self" && B !== "__source" && (w[B] = E[B]);
    var il = arguments.length - 2;
    if (il === 1) w.children = R;
    else if (1 < il) {
      for (var Zl = Array(il), zl = 0; zl < il; zl++)
        Zl[zl] = arguments[zl + 2];
      w.children = Zl;
    }
    if (r && r.defaultProps)
      for (B in il = r.defaultProps, il)
        w[B] === void 0 && (w[B] = il[B]);
    return _t(r, k, w);
  }, J.createRef = function() {
    return { current: null };
  }, J.forwardRef = function(r) {
    return { $$typeof: L, render: r };
  }, J.isValidElement = Mt, J.lazy = function(r) {
    return {
      $$typeof: C,
      _payload: { _status: -1, _result: r },
      _init: Z
    };
  }, J.memo = function(r, E) {
    return {
      $$typeof: p,
      type: r,
      compare: E === void 0 ? null : E
    };
  }, J.startTransition = function(r) {
    var E = tl.T, R = {};
    tl.T = R;
    try {
      var B = r(), w = tl.S;
      w !== null && w(R, B), typeof B == "object" && B !== null && typeof B.then == "function" && B.then(Kl, sl);
    } catch (k) {
      sl(k);
    } finally {
      E !== null && R.types !== null && (E.types = R.types), tl.T = E;
    }
  }, J.unstable_useCacheRefresh = function() {
    return tl.H.useCacheRefresh();
  }, J.use = function(r) {
    return tl.H.use(r);
  }, J.useActionState = function(r, E, R) {
    return tl.H.useActionState(r, E, R);
  }, J.useCallback = function(r, E) {
    return tl.H.useCallback(r, E);
  }, J.useContext = function(r) {
    return tl.H.useContext(r);
  }, J.useDebugValue = function() {
  }, J.useDeferredValue = function(r, E) {
    return tl.H.useDeferredValue(r, E);
  }, J.useEffect = function(r, E) {
    return tl.H.useEffect(r, E);
  }, J.useEffectEvent = function(r) {
    return tl.H.useEffectEvent(r);
  }, J.useId = function() {
    return tl.H.useId();
  }, J.useImperativeHandle = function(r, E, R) {
    return tl.H.useImperativeHandle(r, E, R);
  }, J.useInsertionEffect = function(r, E) {
    return tl.H.useInsertionEffect(r, E);
  }, J.useLayoutEffect = function(r, E) {
    return tl.H.useLayoutEffect(r, E);
  }, J.useMemo = function(r, E) {
    return tl.H.useMemo(r, E);
  }, J.useOptimistic = function(r, E) {
    return tl.H.useOptimistic(r, E);
  }, J.useReducer = function(r, E, R) {
    return tl.H.useReducer(r, E, R);
  }, J.useRef = function(r) {
    return tl.H.useRef(r);
  }, J.useState = function(r) {
    return tl.H.useState(r);
  }, J.useSyncExternalStore = function(r, E, R) {
    return tl.H.useSyncExternalStore(
      r,
      E,
      R
    );
  }, J.useTransition = function() {
    return tl.H.useTransition();
  }, J.version = "19.2.8", J;
}
var Hr;
function Of() {
  return Hr || (Hr = 1, Af.exports = Sv()), Af.exports;
}
var gl = Of(), zf = { exports: {} }, Mu = {}, Tf = { exports: {} }, xf = {};
var qr;
function bv() {
  return qr || (qr = 1, (function(m) {
    function x(j, U) {
      var Z = j.length;
      j.push(U);
      l: for (; 0 < Z; ) {
        var sl = Z - 1 >>> 1, ml = j[sl];
        if (0 < M(ml, U))
          j[sl] = U, j[Z] = ml, Z = sl;
        else break l;
      }
    }
    function _(j) {
      return j.length === 0 ? null : j[0];
    }
    function o(j) {
      if (j.length === 0) return null;
      var U = j[0], Z = j.pop();
      if (Z !== U) {
        j[0] = Z;
        l: for (var sl = 0, ml = j.length, r = ml >>> 1; sl < r; ) {
          var E = 2 * (sl + 1) - 1, R = j[E], B = E + 1, w = j[B];
          if (0 > M(R, Z))
            B < ml && 0 > M(w, R) ? (j[sl] = w, j[B] = Z, sl = B) : (j[sl] = R, j[E] = Z, sl = E);
          else if (B < ml && 0 > M(w, Z))
            j[sl] = w, j[B] = Z, sl = B;
          else break l;
        }
      }
      return U;
    }
    function M(j, U) {
      var Z = j.sortIndex - U.sortIndex;
      return Z !== 0 ? Z : j.id - U.id;
    }
    if (m.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
      var D = performance;
      m.unstable_now = function() {
        return D.now();
      };
    } else {
      var V = Date, L = V.now();
      m.unstable_now = function() {
        return V.now() - L;
      };
    }
    var O = [], p = [], C = 1, A = null, N = 3, G = !1, jl = !1, Al = !1, Rl = !1, q = typeof setTimeout == "function" ? setTimeout : null, K = typeof clearTimeout == "function" ? clearTimeout : null, El = typeof setImmediate < "u" ? setImmediate : null;
    function Xl(j) {
      for (var U = _(p); U !== null; ) {
        if (U.callback === null) o(p);
        else if (U.startTime <= j)
          o(p), U.sortIndex = U.expirationTime, x(O, U);
        else break;
        U = _(p);
      }
    }
    function Ot(j) {
      if (Al = !1, Xl(j), !jl)
        if (_(O) !== null)
          jl = !0, Kl || (Kl = !0, wl());
        else {
          var U = _(p);
          U !== null && Tt(Ot, U.startTime - j);
        }
    }
    var Kl = !1, tl = -1, Jl = 5, _t = -1;
    function We() {
      return Rl ? !0 : !(m.unstable_now() - _t < Jl);
    }
    function Mt() {
      if (Rl = !1, Kl) {
        var j = m.unstable_now();
        _t = j;
        var U = !0;
        try {
          l: {
            jl = !1, Al && (Al = !1, K(tl), tl = -1), G = !0;
            var Z = N;
            try {
              t: {
                for (Xl(j), A = _(O); A !== null && !(A.expirationTime > j && We()); ) {
                  var sl = A.callback;
                  if (typeof sl == "function") {
                    A.callback = null, N = A.priorityLevel;
                    var ml = sl(
                      A.expirationTime <= j
                    );
                    if (j = m.unstable_now(), typeof ml == "function") {
                      A.callback = ml, Xl(j), U = !0;
                      break t;
                    }
                    A === _(O) && o(O), Xl(j);
                  } else o(O);
                  A = _(O);
                }
                if (A !== null) U = !0;
                else {
                  var r = _(p);
                  r !== null && Tt(
                    Ot,
                    r.startTime - j
                  ), U = !1;
                }
              }
              break l;
            } finally {
              A = null, N = Z, G = !1;
            }
            U = void 0;
          }
        } finally {
          U ? wl() : Kl = !1;
        }
      }
    }
    var wl;
    if (typeof El == "function")
      wl = function() {
        El(Mt);
      };
    else if (typeof MessageChannel < "u") {
      var Oe = new MessageChannel(), Ht = Oe.port2;
      Oe.port1.onmessage = Mt, wl = function() {
        Ht.postMessage(null);
      };
    } else
      wl = function() {
        q(Mt, 0);
      };
    function Tt(j, U) {
      tl = q(function() {
        j(m.unstable_now());
      }, U);
    }
    m.unstable_IdlePriority = 5, m.unstable_ImmediatePriority = 1, m.unstable_LowPriority = 4, m.unstable_NormalPriority = 3, m.unstable_Profiling = null, m.unstable_UserBlockingPriority = 2, m.unstable_cancelCallback = function(j) {
      j.callback = null;
    }, m.unstable_forceFrameRate = function(j) {
      0 > j || 125 < j ? console.error(
        "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
      ) : Jl = 0 < j ? Math.floor(1e3 / j) : 5;
    }, m.unstable_getCurrentPriorityLevel = function() {
      return N;
    }, m.unstable_next = function(j) {
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
        return j();
      } finally {
        N = Z;
      }
    }, m.unstable_requestPaint = function() {
      Rl = !0;
    }, m.unstable_runWithPriority = function(j, U) {
      switch (j) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
          break;
        default:
          j = 3;
      }
      var Z = N;
      N = j;
      try {
        return U();
      } finally {
        N = Z;
      }
    }, m.unstable_scheduleCallback = function(j, U, Z) {
      var sl = m.unstable_now();
      switch (typeof Z == "object" && Z !== null ? (Z = Z.delay, Z = typeof Z == "number" && 0 < Z ? sl + Z : sl) : Z = sl, j) {
        case 1:
          var ml = -1;
          break;
        case 2:
          ml = 250;
          break;
        case 5:
          ml = 1073741823;
          break;
        case 4:
          ml = 1e4;
          break;
        default:
          ml = 5e3;
      }
      return ml = Z + ml, j = {
        id: C++,
        callback: U,
        priorityLevel: j,
        startTime: Z,
        expirationTime: ml,
        sortIndex: -1
      }, Z > sl ? (j.sortIndex = Z, x(p, j), _(O) === null && j === _(p) && (Al ? (K(tl), tl = -1) : Al = !0, Tt(Ot, Z - sl))) : (j.sortIndex = ml, x(O, j), jl || G || (jl = !0, Kl || (Kl = !0, wl()))), j;
    }, m.unstable_shouldYield = We, m.unstable_wrapCallback = function(j) {
      var U = N;
      return function() {
        var Z = N;
        N = U;
        try {
          return j.apply(this, arguments);
        } finally {
          N = Z;
        }
      };
    };
  })(xf)), xf;
}
var Br;
function pv() {
  return Br || (Br = 1, Tf.exports = bv()), Tf.exports;
}
var Ef = { exports: {} }, Ql = {};
var Yr;
function jv() {
  if (Yr) return Ql;
  Yr = 1;
  var m = Of();
  function x(O) {
    var p = "https://react.dev/errors/" + O;
    if (1 < arguments.length) {
      p += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var C = 2; C < arguments.length; C++)
        p += "&args[]=" + encodeURIComponent(arguments[C]);
    }
    return "Minified React error #" + O + "; visit " + p + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function _() {
  }
  var o = {
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
  }, M = /* @__PURE__ */ Symbol.for("react.portal");
  function D(O, p, C) {
    var A = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: M,
      key: A == null ? null : "" + A,
      children: O,
      containerInfo: p,
      implementation: C
    };
  }
  var V = m.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function L(O, p) {
    if (O === "font") return "";
    if (typeof p == "string")
      return p === "use-credentials" ? p : "";
  }
  return Ql.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = o, Ql.createPortal = function(O, p) {
    var C = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!p || p.nodeType !== 1 && p.nodeType !== 9 && p.nodeType !== 11)
      throw Error(x(299));
    return D(O, p, null, C);
  }, Ql.flushSync = function(O) {
    var p = V.T, C = o.p;
    try {
      if (V.T = null, o.p = 2, O) return O();
    } finally {
      V.T = p, o.p = C, o.d.f();
    }
  }, Ql.preconnect = function(O, p) {
    typeof O == "string" && (p ? (p = p.crossOrigin, p = typeof p == "string" ? p === "use-credentials" ? p : "" : void 0) : p = null, o.d.C(O, p));
  }, Ql.prefetchDNS = function(O) {
    typeof O == "string" && o.d.D(O);
  }, Ql.preinit = function(O, p) {
    if (typeof O == "string" && p && typeof p.as == "string") {
      var C = p.as, A = L(C, p.crossOrigin), N = typeof p.integrity == "string" ? p.integrity : void 0, G = typeof p.fetchPriority == "string" ? p.fetchPriority : void 0;
      C === "style" ? o.d.S(
        O,
        typeof p.precedence == "string" ? p.precedence : void 0,
        {
          crossOrigin: A,
          integrity: N,
          fetchPriority: G
        }
      ) : C === "script" && o.d.X(O, {
        crossOrigin: A,
        integrity: N,
        fetchPriority: G,
        nonce: typeof p.nonce == "string" ? p.nonce : void 0
      });
    }
  }, Ql.preinitModule = function(O, p) {
    if (typeof O == "string")
      if (typeof p == "object" && p !== null) {
        if (p.as == null || p.as === "script") {
          var C = L(
            p.as,
            p.crossOrigin
          );
          o.d.M(O, {
            crossOrigin: C,
            integrity: typeof p.integrity == "string" ? p.integrity : void 0,
            nonce: typeof p.nonce == "string" ? p.nonce : void 0
          });
        }
      } else p == null && o.d.M(O);
  }, Ql.preload = function(O, p) {
    if (typeof O == "string" && typeof p == "object" && p !== null && typeof p.as == "string") {
      var C = p.as, A = L(C, p.crossOrigin);
      o.d.L(O, C, {
        crossOrigin: A,
        integrity: typeof p.integrity == "string" ? p.integrity : void 0,
        nonce: typeof p.nonce == "string" ? p.nonce : void 0,
        type: typeof p.type == "string" ? p.type : void 0,
        fetchPriority: typeof p.fetchPriority == "string" ? p.fetchPriority : void 0,
        referrerPolicy: typeof p.referrerPolicy == "string" ? p.referrerPolicy : void 0,
        imageSrcSet: typeof p.imageSrcSet == "string" ? p.imageSrcSet : void 0,
        imageSizes: typeof p.imageSizes == "string" ? p.imageSizes : void 0,
        media: typeof p.media == "string" ? p.media : void 0
      });
    }
  }, Ql.preloadModule = function(O, p) {
    if (typeof O == "string")
      if (p) {
        var C = L(p.as, p.crossOrigin);
        o.d.m(O, {
          as: typeof p.as == "string" && p.as !== "script" ? p.as : void 0,
          crossOrigin: C,
          integrity: typeof p.integrity == "string" ? p.integrity : void 0
        });
      } else o.d.m(O);
  }, Ql.requestFormReset = function(O) {
    o.d.r(O);
  }, Ql.unstable_batchedUpdates = function(O, p) {
    return O(p);
  }, Ql.useFormState = function(O, p, C) {
    return V.H.useFormState(O, p, C);
  }, Ql.useFormStatus = function() {
    return V.H.useHostTransitionStatus();
  }, Ql.version = "19.2.8", Ql;
}
var Gr;
function Av() {
  if (Gr) return Ef.exports;
  Gr = 1;
  function m() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(m);
      } catch (x) {
        console.error(x);
      }
  }
  return m(), Ef.exports = jv(), Ef.exports;
}
var Xr;
function zv() {
  if (Xr) return Mu;
  Xr = 1;
  var m = pv(), x = Of(), _ = Av();
  function o(l) {
    var t = "https://react.dev/errors/" + l;
    if (1 < arguments.length) {
      t += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var e = 2; e < arguments.length; e++)
        t += "&args[]=" + encodeURIComponent(arguments[e]);
    }
    return "Minified React error #" + l + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function M(l) {
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
  function V(l) {
    if (l.tag === 13) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function L(l) {
    if (l.tag === 31) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function O(l) {
    if (D(l) !== l)
      throw Error(o(188));
  }
  function p(l) {
    var t = l.alternate;
    if (!t) {
      if (t = D(l), t === null) throw Error(o(188));
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
        throw Error(o(188));
      }
      if (e.return !== a.return) e = u, a = n;
      else {
        for (var i = !1, f = u.child; f; ) {
          if (f === e) {
            i = !0, e = u, a = n;
            break;
          }
          if (f === a) {
            i = !0, a = u, e = n;
            break;
          }
          f = f.sibling;
        }
        if (!i) {
          for (f = n.child; f; ) {
            if (f === e) {
              i = !0, e = n, a = u;
              break;
            }
            if (f === a) {
              i = !0, a = n, e = u;
              break;
            }
            f = f.sibling;
          }
          if (!i) throw Error(o(189));
        }
      }
      if (e.alternate !== a) throw Error(o(190));
    }
    if (e.tag !== 3) throw Error(o(188));
    return e.stateNode.current === e ? l : t;
  }
  function C(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l;
    for (l = l.child; l !== null; ) {
      if (t = C(l), t !== null) return t;
      l = l.sibling;
    }
    return null;
  }
  var A = Object.assign, N = /* @__PURE__ */ Symbol.for("react.element"), G = /* @__PURE__ */ Symbol.for("react.transitional.element"), jl = /* @__PURE__ */ Symbol.for("react.portal"), Al = /* @__PURE__ */ Symbol.for("react.fragment"), Rl = /* @__PURE__ */ Symbol.for("react.strict_mode"), q = /* @__PURE__ */ Symbol.for("react.profiler"), K = /* @__PURE__ */ Symbol.for("react.consumer"), El = /* @__PURE__ */ Symbol.for("react.context"), Xl = /* @__PURE__ */ Symbol.for("react.forward_ref"), Ot = /* @__PURE__ */ Symbol.for("react.suspense"), Kl = /* @__PURE__ */ Symbol.for("react.suspense_list"), tl = /* @__PURE__ */ Symbol.for("react.memo"), Jl = /* @__PURE__ */ Symbol.for("react.lazy"), _t = /* @__PURE__ */ Symbol.for("react.activity"), We = /* @__PURE__ */ Symbol.for("react.memo_cache_sentinel"), Mt = Symbol.iterator;
  function wl(l) {
    return l === null || typeof l != "object" ? null : (l = Mt && l[Mt] || l["@@iterator"], typeof l == "function" ? l : null);
  }
  var Oe = /* @__PURE__ */ Symbol.for("react.client.reference");
  function Ht(l) {
    if (l == null) return null;
    if (typeof l == "function")
      return l.$$typeof === Oe ? null : l.displayName || l.name || null;
    if (typeof l == "string") return l;
    switch (l) {
      case Al:
        return "Fragment";
      case q:
        return "Profiler";
      case Rl:
        return "StrictMode";
      case Ot:
        return "Suspense";
      case Kl:
        return "SuspenseList";
      case _t:
        return "Activity";
    }
    if (typeof l == "object")
      switch (l.$$typeof) {
        case jl:
          return "Portal";
        case El:
          return l.displayName || "Context";
        case K:
          return (l._context.displayName || "Context") + ".Consumer";
        case Xl:
          var t = l.render;
          return l = l.displayName, l || (l = t.displayName || t.name || "", l = l !== "" ? "ForwardRef(" + l + ")" : "ForwardRef"), l;
        case tl:
          return t = l.displayName || null, t !== null ? t : Ht(l.type) || "Memo";
        case Jl:
          t = l._payload, l = l._init;
          try {
            return Ht(l(t));
          } catch {
          }
      }
    return null;
  }
  var Tt = Array.isArray, j = x.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, U = _.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, Z = {
    pending: !1,
    data: null,
    method: null,
    action: null
  }, sl = [], ml = -1;
  function r(l) {
    return { current: l };
  }
  function E(l) {
    0 > ml || (l.current = sl[ml], sl[ml] = null, ml--);
  }
  function R(l, t) {
    ml++, sl[ml] = l.current, l.current = t;
  }
  var B = r(null), w = r(null), k = r(null), il = r(null);
  function Zl(l, t) {
    switch (R(k, t), R(w, l), R(B, null), t.nodeType) {
      case 9:
      case 11:
        l = (l = t.documentElement) && (l = l.namespaceURI) ? tr(l) : 0;
        break;
      default:
        if (l = t.tagName, t = t.namespaceURI)
          t = tr(t), l = er(t, l);
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
    E(B), R(B, l);
  }
  function zl() {
    E(B), E(w), E(k);
  }
  function qa(l) {
    l.memoizedState !== null && R(il, l);
    var t = B.current, e = er(t, l.type);
    t !== e && (R(w, l), R(B, e));
  }
  function Ru(l) {
    w.current === l && (E(B), E(w)), il.current === l && (E(il), xu._currentValue = Z);
  }
  var ei, Mf;
  function _e(l) {
    if (ei === void 0)
      try {
        throw Error();
      } catch (e) {
        var t = e.stack.trim().match(/\n( *(at )?)/);
        ei = t && t[1] || "", Mf = -1 < e.stack.indexOf(`
    at`) ? " (<anonymous>)" : -1 < e.stack.indexOf("@") ? "@unknown:0:0" : "";
      }
    return `
` + ei + l + Mf;
  }
  var ai = !1;
  function ui(l, t) {
    if (!l || ai) return "";
    ai = !0;
    var e = Error.prepareStackTrace;
    Error.prepareStackTrace = void 0;
    try {
      var a = {
        DetermineComponentFrameRoot: function() {
          try {
            if (t) {
              var T = function() {
                throw Error();
              };
              if (Object.defineProperty(T.prototype, "props", {
                set: function() {
                  throw Error();
                }
              }), typeof Reflect == "object" && Reflect.construct) {
                try {
                  Reflect.construct(T, []);
                } catch (S) {
                  var g = S;
                }
                Reflect.construct(l, [], T);
              } else {
                try {
                  T.call();
                } catch (S) {
                  g = S;
                }
                l.call(T.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (S) {
                g = S;
              }
              (T = l()) && typeof T.catch == "function" && T.catch(function() {
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
      var n = a.DetermineComponentFrameRoot(), i = n[0], f = n[1];
      if (i && f) {
        var s = i.split(`
`), y = f.split(`
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
      ai = !1, Error.prepareStackTrace = e;
    }
    return (e = l ? l.displayName || l.name : "") ? _e(e) : "";
  }
  function wr(l, t) {
    switch (l.tag) {
      case 26:
      case 27:
      case 5:
        return _e(l.type);
      case 16:
        return _e("Lazy");
      case 13:
        return l.child !== t && t !== null ? _e("Suspense Fallback") : _e("Suspense");
      case 19:
        return _e("SuspenseList");
      case 0:
      case 15:
        return ui(l.type, !1);
      case 11:
        return ui(l.type.render, !1);
      case 1:
        return ui(l.type, !0);
      case 31:
        return _e("Activity");
      default:
        return "";
    }
  }
  function Df(l) {
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
  var ni = Object.prototype.hasOwnProperty, ii = m.unstable_scheduleCallback, ci = m.unstable_cancelCallback, $r = m.unstable_shouldYield, Wr = m.unstable_requestPaint, at = m.unstable_now, kr = m.unstable_getCurrentPriorityLevel, Uf = m.unstable_ImmediatePriority, Cf = m.unstable_UserBlockingPriority, Hu = m.unstable_NormalPriority, Fr = m.unstable_LowPriority, Rf = m.unstable_IdlePriority, Ir = m.log, Pr = m.unstable_setDisableYieldValue, Ba = null, ut = null;
  function te(l) {
    if (typeof Ir == "function" && Pr(l), ut && typeof ut.setStrictMode == "function")
      try {
        ut.setStrictMode(Ba, l);
      } catch {
      }
  }
  var nt = Math.clz32 ? Math.clz32 : em, lm = Math.log, tm = Math.LN2;
  function em(l) {
    return l >>>= 0, l === 0 ? 32 : 31 - (lm(l) / tm | 0) | 0;
  }
  var qu = 256, Bu = 262144, Yu = 4194304;
  function Me(l) {
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
  function Gu(l, t, e) {
    var a = l.pendingLanes;
    if (a === 0) return 0;
    var u = 0, n = l.suspendedLanes, i = l.pingedLanes;
    l = l.warmLanes;
    var f = a & 134217727;
    return f !== 0 ? (a = f & ~n, a !== 0 ? u = Me(a) : (i &= f, i !== 0 ? u = Me(i) : e || (e = f & ~l, e !== 0 && (u = Me(e))))) : (f = a & ~n, f !== 0 ? u = Me(f) : i !== 0 ? u = Me(i) : e || (e = a & ~l, e !== 0 && (u = Me(e)))), u === 0 ? 0 : t !== 0 && t !== u && (t & n) === 0 && (n = u & -u, e = t & -t, n >= e || n === 32 && (e & 4194048) !== 0) ? t : u;
  }
  function Ya(l, t) {
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
  function Hf() {
    var l = Yu;
    return Yu <<= 1, (Yu & 62914560) === 0 && (Yu = 4194304), l;
  }
  function fi(l) {
    for (var t = [], e = 0; 31 > e; e++) t.push(l);
    return t;
  }
  function Ga(l, t) {
    l.pendingLanes |= t, t !== 268435456 && (l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0);
  }
  function um(l, t, e, a, u, n) {
    var i = l.pendingLanes;
    l.pendingLanes = e, l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0, l.expiredLanes &= e, l.entangledLanes &= e, l.errorRecoveryDisabledLanes &= e, l.shellSuspendCounter = 0;
    var f = l.entanglements, s = l.expirationTimes, y = l.hiddenUpdates;
    for (e = i & ~e; 0 < e; ) {
      var b = 31 - nt(e), T = 1 << b;
      f[b] = 0, s[b] = -1;
      var g = y[b];
      if (g !== null)
        for (y[b] = null, b = 0; b < g.length; b++) {
          var S = g[b];
          S !== null && (S.lane &= -536870913);
        }
      e &= ~T;
    }
    a !== 0 && qf(l, a, 0), n !== 0 && u === 0 && l.tag !== 0 && (l.suspendedLanes |= n & ~(i & ~t));
  }
  function qf(l, t, e) {
    l.pendingLanes |= t, l.suspendedLanes &= ~t;
    var a = 31 - nt(t);
    l.entangledLanes |= t, l.entanglements[a] = l.entanglements[a] | 1073741824 | e & 261930;
  }
  function Bf(l, t) {
    var e = l.entangledLanes |= t;
    for (l = l.entanglements; e; ) {
      var a = 31 - nt(e), u = 1 << a;
      u & t | l[a] & t && (l[a] |= t), e &= ~u;
    }
  }
  function Yf(l, t) {
    var e = t & -t;
    return e = (e & 42) !== 0 ? 1 : si(e), (e & (l.suspendedLanes | t)) !== 0 ? 0 : e;
  }
  function si(l) {
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
  function oi(l) {
    return l &= -l, 2 < l ? 8 < l ? (l & 134217727) !== 0 ? 32 : 268435456 : 8 : 2;
  }
  function Gf() {
    var l = U.p;
    return l !== 0 ? l : (l = window.event, l === void 0 ? 32 : xr(l.type));
  }
  function Xf(l, t) {
    var e = U.p;
    try {
      return U.p = l, t();
    } finally {
      U.p = e;
    }
  }
  var ee = Math.random().toString(36).slice(2), Hl = "__reactFiber$" + ee, $l = "__reactProps$" + ee, ke = "__reactContainer$" + ee, di = "__reactEvents$" + ee, nm = "__reactListeners$" + ee, im = "__reactHandles$" + ee, Qf = "__reactResources$" + ee, Xa = "__reactMarker$" + ee;
  function ri(l) {
    delete l[Hl], delete l[$l], delete l[di], delete l[nm], delete l[im];
  }
  function Fe(l) {
    var t = l[Hl];
    if (t) return t;
    for (var e = l.parentNode; e; ) {
      if (t = e[ke] || e[Hl]) {
        if (e = t.alternate, t.child !== null || e !== null && e.child !== null)
          for (l = sr(l); l !== null; ) {
            if (e = l[Hl]) return e;
            l = sr(l);
          }
        return t;
      }
      l = e, e = l.parentNode;
    }
    return null;
  }
  function Ie(l) {
    if (l = l[Hl] || l[ke]) {
      var t = l.tag;
      if (t === 5 || t === 6 || t === 13 || t === 31 || t === 26 || t === 27 || t === 3)
        return l;
    }
    return null;
  }
  function Qa(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l.stateNode;
    throw Error(o(33));
  }
  function Pe(l) {
    var t = l[Qf];
    return t || (t = l[Qf] = { hoistableStyles: /* @__PURE__ */ new Map(), hoistableScripts: /* @__PURE__ */ new Map() }), t;
  }
  function Ul(l) {
    l[Xa] = !0;
  }
  var Lf = /* @__PURE__ */ new Set(), Zf = {};
  function De(l, t) {
    la(l, t), la(l + "Capture", t);
  }
  function la(l, t) {
    for (Zf[l] = t, l = 0; l < t.length; l++)
      Lf.add(t[l]);
  }
  var cm = RegExp(
    "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"
  ), Vf = {}, Kf = {};
  function fm(l) {
    return ni.call(Kf, l) ? !0 : ni.call(Vf, l) ? !1 : cm.test(l) ? Kf[l] = !0 : (Vf[l] = !0, !1);
  }
  function Xu(l, t, e) {
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
  function Qu(l, t, e) {
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
  function Jf(l) {
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
  function mi(l) {
    if (!l._valueTracker) {
      var t = Jf(l) ? "checked" : "value";
      l._valueTracker = sm(
        l,
        t,
        "" + l[t]
      );
    }
  }
  function wf(l) {
    if (!l) return !1;
    var t = l._valueTracker;
    if (!t) return !0;
    var e = t.getValue(), a = "";
    return l && (a = Jf(l) ? l.checked ? "true" : "false" : l.value), l = a, l !== e ? (t.setValue(l), !0) : !1;
  }
  function Lu(l) {
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
  function hi(l, t, e, a, u, n, i, f) {
    l.name = "", i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" ? l.type = i : l.removeAttribute("type"), t != null ? i === "number" ? (t === 0 && l.value === "" || l.value != t) && (l.value = "" + mt(t)) : l.value !== "" + mt(t) && (l.value = "" + mt(t)) : i !== "submit" && i !== "reset" || l.removeAttribute("value"), t != null ? vi(l, i, mt(t)) : e != null ? vi(l, i, mt(e)) : a != null && l.removeAttribute("value"), u == null && n != null && (l.defaultChecked = !!n), u != null && (l.checked = u && typeof u != "function" && typeof u != "symbol"), f != null && typeof f != "function" && typeof f != "symbol" && typeof f != "boolean" ? l.name = "" + mt(f) : l.removeAttribute("name");
  }
  function $f(l, t, e, a, u, n, i, f) {
    if (n != null && typeof n != "function" && typeof n != "symbol" && typeof n != "boolean" && (l.type = n), t != null || e != null) {
      if (!(n !== "submit" && n !== "reset" || t != null)) {
        mi(l);
        return;
      }
      e = e != null ? "" + mt(e) : "", t = t != null ? "" + mt(t) : e, f || t === l.value || (l.value = t), l.defaultValue = t;
    }
    a = a ?? u, a = typeof a != "function" && typeof a != "symbol" && !!a, l.checked = f ? l.checked : !!a, l.defaultChecked = !!a, i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" && (l.name = i), mi(l);
  }
  function vi(l, t, e) {
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
  function Wf(l, t, e) {
    if (t != null && (t = "" + mt(t), t !== l.value && (l.value = t), e == null)) {
      l.defaultValue !== t && (l.defaultValue = t);
      return;
    }
    l.defaultValue = e != null ? "" + mt(e) : "";
  }
  function kf(l, t, e, a) {
    if (t == null) {
      if (a != null) {
        if (e != null) throw Error(o(92));
        if (Tt(a)) {
          if (1 < a.length) throw Error(o(93));
          a = a[0];
        }
        e = a;
      }
      e == null && (e = ""), t = e;
    }
    e = mt(t), l.defaultValue = e, a = l.textContent, a === e && a !== "" && a !== null && (l.value = a), mi(l);
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
  var dm = new Set(
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
      " "
    )
  );
  function Ff(l, t, e) {
    var a = t.indexOf("--") === 0;
    e == null || typeof e == "boolean" || e === "" ? a ? l.setProperty(t, "") : t === "float" ? l.cssFloat = "" : l[t] = "" : a ? l.setProperty(t, e) : typeof e != "number" || e === 0 || dm.has(t) ? t === "float" ? l.cssFloat = e : l[t] = ("" + e).trim() : l[t] = e + "px";
  }
  function If(l, t, e) {
    if (t != null && typeof t != "object")
      throw Error(o(62));
    if (l = l.style, e != null) {
      for (var a in e)
        !e.hasOwnProperty(a) || t != null && t.hasOwnProperty(a) || (a.indexOf("--") === 0 ? l.setProperty(a, "") : a === "float" ? l.cssFloat = "" : l[a] = "");
      for (var u in t)
        a = t[u], t.hasOwnProperty(u) && e[u] !== a && Ff(l, u, a);
    } else
      for (var n in t)
        t.hasOwnProperty(n) && Ff(l, n, t[n]);
  }
  function yi(l) {
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
  function Zu(l) {
    return mm.test("" + l) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : l;
  }
  function Bt() {
  }
  var gi = null;
  function Si(l) {
    return l = l.target || l.srcElement || window, l.correspondingUseElement && (l = l.correspondingUseElement), l.nodeType === 3 ? l.parentNode : l;
  }
  var aa = null, ua = null;
  function Pf(l) {
    var t = Ie(l);
    if (t && (l = t.stateNode)) {
      var e = l[$l] || null;
      l: switch (l = t.stateNode, t.type) {
        case "input":
          if (hi(
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
                if (!u) throw Error(o(90));
                hi(
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
              a = e[t], a.form === l.form && wf(a);
          }
          break l;
        case "textarea":
          Wf(l, e.value, e.defaultValue);
          break l;
        case "select":
          t = e.value, t != null && ta(l, !!e.multiple, t, !1);
      }
    }
  }
  var bi = !1;
  function ls(l, t, e) {
    if (bi) return l(t, e);
    bi = !0;
    try {
      var a = l(t);
      return a;
    } finally {
      if (bi = !1, (aa !== null || ua !== null) && (Dn(), aa && (t = aa, l = ua, ua = aa = null, Pf(t), l)))
        for (t = 0; t < l.length; t++) Pf(l[t]);
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
        o(231, t, typeof e)
      );
    return e;
  }
  var Yt = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), pi = !1;
  if (Yt)
    try {
      var Za = {};
      Object.defineProperty(Za, "passive", {
        get: function() {
          pi = !0;
        }
      }), window.addEventListener("test", Za, Za), window.removeEventListener("test", Za, Za);
    } catch {
      pi = !1;
    }
  var ae = null, ji = null, Vu = null;
  function ts() {
    if (Vu) return Vu;
    var l, t = ji, e = t.length, a, u = "value" in ae ? ae.value : ae.textContent, n = u.length;
    for (l = 0; l < e && t[l] === u[l]; l++) ;
    var i = e - l;
    for (a = 1; a <= i && t[e - a] === u[n - a]; a++) ;
    return Vu = u.slice(l, 1 < a ? 1 - a : void 0);
  }
  function Ku(l) {
    var t = l.keyCode;
    return "charCode" in l ? (l = l.charCode, l === 0 && t === 13 && (l = 13)) : l = t, l === 10 && (l = 13), 32 <= l || l === 13 ? l : 0;
  }
  function Ju() {
    return !0;
  }
  function es() {
    return !1;
  }
  function Wl(l) {
    function t(e, a, u, n, i) {
      this._reactName = e, this._targetInst = u, this.type = a, this.nativeEvent = n, this.target = i, this.currentTarget = null;
      for (var f in l)
        l.hasOwnProperty(f) && (e = l[f], this[f] = e ? e(n) : n[f]);
      return this.isDefaultPrevented = (n.defaultPrevented != null ? n.defaultPrevented : n.returnValue === !1) ? Ju : es, this.isPropagationStopped = es, this;
    }
    return A(t.prototype, {
      preventDefault: function() {
        this.defaultPrevented = !0;
        var e = this.nativeEvent;
        e && (e.preventDefault ? e.preventDefault() : typeof e.returnValue != "unknown" && (e.returnValue = !1), this.isDefaultPrevented = Ju);
      },
      stopPropagation: function() {
        var e = this.nativeEvent;
        e && (e.stopPropagation ? e.stopPropagation() : typeof e.cancelBubble != "unknown" && (e.cancelBubble = !0), this.isPropagationStopped = Ju);
      },
      persist: function() {
      },
      isPersistent: Ju
    }), t;
  }
  var Ue = {
    eventPhase: 0,
    bubbles: 0,
    cancelable: 0,
    timeStamp: function(l) {
      return l.timeStamp || Date.now();
    },
    defaultPrevented: 0,
    isTrusted: 0
  }, wu = Wl(Ue), Va = A({}, Ue, { view: 0, detail: 0 }), hm = Wl(Va), Ai, zi, Ka, $u = A({}, Va, {
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
    getModifierState: xi,
    button: 0,
    buttons: 0,
    relatedTarget: function(l) {
      return l.relatedTarget === void 0 ? l.fromElement === l.srcElement ? l.toElement : l.fromElement : l.relatedTarget;
    },
    movementX: function(l) {
      return "movementX" in l ? l.movementX : (l !== Ka && (Ka && l.type === "mousemove" ? (Ai = l.screenX - Ka.screenX, zi = l.screenY - Ka.screenY) : zi = Ai = 0, Ka = l), Ai);
    },
    movementY: function(l) {
      return "movementY" in l ? l.movementY : zi;
    }
  }), as = Wl($u), vm = A({}, $u, { dataTransfer: 0 }), ym = Wl(vm), gm = A({}, Va, { relatedTarget: 0 }), Ti = Wl(gm), Sm = A({}, Ue, {
    animationName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), bm = Wl(Sm), pm = A({}, Ue, {
    clipboardData: function(l) {
      return "clipboardData" in l ? l.clipboardData : window.clipboardData;
    }
  }), jm = Wl(pm), Am = A({}, Ue, { data: 0 }), us = Wl(Am), zm = {
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
  }, Tm = {
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
  }, xm = {
    Alt: "altKey",
    Control: "ctrlKey",
    Meta: "metaKey",
    Shift: "shiftKey"
  };
  function Em(l) {
    var t = this.nativeEvent;
    return t.getModifierState ? t.getModifierState(l) : (l = xm[l]) ? !!t[l] : !1;
  }
  function xi() {
    return Em;
  }
  var Nm = A({}, Va, {
    key: function(l) {
      if (l.key) {
        var t = zm[l.key] || l.key;
        if (t !== "Unidentified") return t;
      }
      return l.type === "keypress" ? (l = Ku(l), l === 13 ? "Enter" : String.fromCharCode(l)) : l.type === "keydown" || l.type === "keyup" ? Tm[l.keyCode] || "Unidentified" : "";
    },
    code: 0,
    location: 0,
    ctrlKey: 0,
    shiftKey: 0,
    altKey: 0,
    metaKey: 0,
    repeat: 0,
    locale: 0,
    getModifierState: xi,
    charCode: function(l) {
      return l.type === "keypress" ? Ku(l) : 0;
    },
    keyCode: function(l) {
      return l.type === "keydown" || l.type === "keyup" ? l.keyCode : 0;
    },
    which: function(l) {
      return l.type === "keypress" ? Ku(l) : l.type === "keydown" || l.type === "keyup" ? l.keyCode : 0;
    }
  }), Om = Wl(Nm), _m = A({}, $u, {
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
  }), ns = Wl(_m), Mm = A({}, Va, {
    touches: 0,
    targetTouches: 0,
    changedTouches: 0,
    altKey: 0,
    metaKey: 0,
    ctrlKey: 0,
    shiftKey: 0,
    getModifierState: xi
  }), Dm = Wl(Mm), Um = A({}, Ue, {
    propertyName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Cm = Wl(Um), Rm = A({}, $u, {
    deltaX: function(l) {
      return "deltaX" in l ? l.deltaX : "wheelDeltaX" in l ? -l.wheelDeltaX : 0;
    },
    deltaY: function(l) {
      return "deltaY" in l ? l.deltaY : "wheelDeltaY" in l ? -l.wheelDeltaY : "wheelDelta" in l ? -l.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), Hm = Wl(Rm), qm = A({}, Ue, {
    newState: 0,
    oldState: 0
  }), Bm = Wl(qm), Ym = [9, 13, 27, 32], Ei = Yt && "CompositionEvent" in window, Ja = null;
  Yt && "documentMode" in document && (Ja = document.documentMode);
  var Gm = Yt && "TextEvent" in window && !Ja, is = Yt && (!Ei || Ja && 8 < Ja && 11 >= Ja), cs = " ", fs = !1;
  function ss(l, t) {
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
  function os(l) {
    return l = l.detail, typeof l == "object" && "data" in l ? l.data : null;
  }
  var na = !1;
  function Xm(l, t) {
    switch (l) {
      case "compositionend":
        return os(t);
      case "keypress":
        return t.which !== 32 ? null : (fs = !0, cs);
      case "textInput":
        return l = t.data, l === cs && fs ? null : l;
      default:
        return null;
    }
  }
  function Qm(l, t) {
    if (na)
      return l === "compositionend" || !Ei && ss(l, t) ? (l = ts(), Vu = ji = ae = null, na = !1, l) : null;
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
        return is && t.locale !== "ko" ? null : t.data;
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
  function ds(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t === "input" ? !!Lm[l.type] : t === "textarea";
  }
  function rs(l, t, e, a) {
    aa ? ua ? ua.push(a) : ua = [a] : aa = a, t = Yn(t, "onChange"), 0 < t.length && (e = new wu(
      "onChange",
      "change",
      null,
      e,
      a
    ), l.push({ event: e, listeners: t }));
  }
  var wa = null, $a = null;
  function Zm(l) {
    Wd(l, 0);
  }
  function Wu(l) {
    var t = Qa(l);
    if (wf(t)) return l;
  }
  function ms(l, t) {
    if (l === "change") return t;
  }
  var hs = !1;
  if (Yt) {
    var Ni;
    if (Yt) {
      var Oi = "oninput" in document;
      if (!Oi) {
        var vs = document.createElement("div");
        vs.setAttribute("oninput", "return;"), Oi = typeof vs.oninput == "function";
      }
      Ni = Oi;
    } else Ni = !1;
    hs = Ni && (!document.documentMode || 9 < document.documentMode);
  }
  function ys() {
    wa && (wa.detachEvent("onpropertychange", gs), $a = wa = null);
  }
  function gs(l) {
    if (l.propertyName === "value" && Wu($a)) {
      var t = [];
      rs(
        t,
        $a,
        l,
        Si(l)
      ), ls(Zm, t);
    }
  }
  function Vm(l, t, e) {
    l === "focusin" ? (ys(), wa = t, $a = e, wa.attachEvent("onpropertychange", gs)) : l === "focusout" && ys();
  }
  function Km(l) {
    if (l === "selectionchange" || l === "keyup" || l === "keydown")
      return Wu($a);
  }
  function Jm(l, t) {
    if (l === "click") return Wu(t);
  }
  function wm(l, t) {
    if (l === "input" || l === "change")
      return Wu(t);
  }
  function $m(l, t) {
    return l === t && (l !== 0 || 1 / l === 1 / t) || l !== l && t !== t;
  }
  var it = typeof Object.is == "function" ? Object.is : $m;
  function Wa(l, t) {
    if (it(l, t)) return !0;
    if (typeof l != "object" || l === null || typeof t != "object" || t === null)
      return !1;
    var e = Object.keys(l), a = Object.keys(t);
    if (e.length !== a.length) return !1;
    for (a = 0; a < e.length; a++) {
      var u = e[a];
      if (!ni.call(t, u) || !it(l[u], t[u]))
        return !1;
    }
    return !0;
  }
  function Ss(l) {
    for (; l && l.firstChild; ) l = l.firstChild;
    return l;
  }
  function bs(l, t) {
    var e = Ss(l);
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
      e = Ss(e);
    }
  }
  function ps(l, t) {
    return l && t ? l === t ? !0 : l && l.nodeType === 3 ? !1 : t && t.nodeType === 3 ? ps(l, t.parentNode) : "contains" in l ? l.contains(t) : l.compareDocumentPosition ? !!(l.compareDocumentPosition(t) & 16) : !1 : !1;
  }
  function js(l) {
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
  function _i(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t && (t === "input" && (l.type === "text" || l.type === "search" || l.type === "tel" || l.type === "url" || l.type === "password") || t === "textarea" || l.contentEditable === "true");
  }
  var Wm = Yt && "documentMode" in document && 11 >= document.documentMode, ia = null, Mi = null, ka = null, Di = !1;
  function As(l, t, e) {
    var a = e.window === e ? e.document : e.nodeType === 9 ? e : e.ownerDocument;
    Di || ia == null || ia !== Lu(a) || (a = ia, "selectionStart" in a && _i(a) ? a = { start: a.selectionStart, end: a.selectionEnd } : (a = (a.ownerDocument && a.ownerDocument.defaultView || window).getSelection(), a = {
      anchorNode: a.anchorNode,
      anchorOffset: a.anchorOffset,
      focusNode: a.focusNode,
      focusOffset: a.focusOffset
    }), ka && Wa(ka, a) || (ka = a, a = Yn(Mi, "onSelect"), 0 < a.length && (t = new wu(
      "onSelect",
      "select",
      null,
      t,
      e
    ), l.push({ event: t, listeners: a }), t.target = ia)));
  }
  function Ce(l, t) {
    var e = {};
    return e[l.toLowerCase()] = t.toLowerCase(), e["Webkit" + l] = "webkit" + t, e["Moz" + l] = "moz" + t, e;
  }
  var ca = {
    animationend: Ce("Animation", "AnimationEnd"),
    animationiteration: Ce("Animation", "AnimationIteration"),
    animationstart: Ce("Animation", "AnimationStart"),
    transitionrun: Ce("Transition", "TransitionRun"),
    transitionstart: Ce("Transition", "TransitionStart"),
    transitioncancel: Ce("Transition", "TransitionCancel"),
    transitionend: Ce("Transition", "TransitionEnd")
  }, Ui = {}, zs = {};
  Yt && (zs = document.createElement("div").style, "AnimationEvent" in window || (delete ca.animationend.animation, delete ca.animationiteration.animation, delete ca.animationstart.animation), "TransitionEvent" in window || delete ca.transitionend.transition);
  function Re(l) {
    if (Ui[l]) return Ui[l];
    if (!ca[l]) return l;
    var t = ca[l], e;
    for (e in t)
      if (t.hasOwnProperty(e) && e in zs)
        return Ui[l] = t[e];
    return l;
  }
  var Ts = Re("animationend"), xs = Re("animationiteration"), Es = Re("animationstart"), km = Re("transitionrun"), Fm = Re("transitionstart"), Im = Re("transitioncancel"), Ns = Re("transitionend"), Os = /* @__PURE__ */ new Map(), Ci = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
    " "
  );
  Ci.push("scrollEnd");
  function xt(l, t) {
    Os.set(l, t), De(t, [l]);
  }
  var ku = typeof reportError == "function" ? reportError : function(l) {
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
  }, vt = [], fa = 0, Ri = 0;
  function Fu() {
    for (var l = fa, t = Ri = fa = 0; t < l; ) {
      var e = vt[t];
      vt[t++] = null;
      var a = vt[t];
      vt[t++] = null;
      var u = vt[t];
      vt[t++] = null;
      var n = vt[t];
      if (vt[t++] = null, a !== null && u !== null) {
        var i = a.pending;
        i === null ? u.next = u : (u.next = i.next, i.next = u), a.pending = u;
      }
      n !== 0 && _s(e, u, n);
    }
  }
  function Iu(l, t, e, a) {
    vt[fa++] = l, vt[fa++] = t, vt[fa++] = e, vt[fa++] = a, Ri |= a, l.lanes |= a, l = l.alternate, l !== null && (l.lanes |= a);
  }
  function Hi(l, t, e, a) {
    return Iu(l, t, e, a), Pu(l);
  }
  function He(l, t) {
    return Iu(l, null, null, t), Pu(l);
  }
  function _s(l, t, e) {
    l.lanes |= e;
    var a = l.alternate;
    a !== null && (a.lanes |= e);
    for (var u = !1, n = l.return; n !== null; )
      n.childLanes |= e, a = n.alternate, a !== null && (a.childLanes |= e), n.tag === 22 && (l = n.stateNode, l === null || l._visibility & 1 || (u = !0)), l = n, n = n.return;
    return l.tag === 3 ? (n = l.stateNode, u && t !== null && (u = 31 - nt(e), l = n.hiddenUpdates, a = l[u], a === null ? l[u] = [t] : a.push(t), t.lane = e | 536870912), n) : null;
  }
  function Pu(l) {
    if (50 < Su)
      throw Su = 0, Vc = null, Error(o(185));
    for (var t = l.return; t !== null; )
      l = t, t = l.return;
    return l.tag === 3 ? l.stateNode : null;
  }
  var sa = {};
  function Pm(l, t, e, a) {
    this.tag = l, this.key = e, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = a, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function ct(l, t, e, a) {
    return new Pm(l, t, e, a);
  }
  function qi(l) {
    return l = l.prototype, !(!l || !l.isReactComponent);
  }
  function Gt(l, t) {
    var e = l.alternate;
    return e === null ? (e = ct(
      l.tag,
      t,
      l.key,
      l.mode
    ), e.elementType = l.elementType, e.type = l.type, e.stateNode = l.stateNode, e.alternate = l, l.alternate = e) : (e.pendingProps = t, e.type = l.type, e.flags = 0, e.subtreeFlags = 0, e.deletions = null), e.flags = l.flags & 65011712, e.childLanes = l.childLanes, e.lanes = l.lanes, e.child = l.child, e.memoizedProps = l.memoizedProps, e.memoizedState = l.memoizedState, e.updateQueue = l.updateQueue, t = l.dependencies, e.dependencies = t === null ? null : { lanes: t.lanes, firstContext: t.firstContext }, e.sibling = l.sibling, e.index = l.index, e.ref = l.ref, e.refCleanup = l.refCleanup, e;
  }
  function Ms(l, t) {
    l.flags &= 65011714;
    var e = l.alternate;
    return e === null ? (l.childLanes = 0, l.lanes = t, l.child = null, l.subtreeFlags = 0, l.memoizedProps = null, l.memoizedState = null, l.updateQueue = null, l.dependencies = null, l.stateNode = null) : (l.childLanes = e.childLanes, l.lanes = e.lanes, l.child = e.child, l.subtreeFlags = 0, l.deletions = null, l.memoizedProps = e.memoizedProps, l.memoizedState = e.memoizedState, l.updateQueue = e.updateQueue, l.type = e.type, t = e.dependencies, l.dependencies = t === null ? null : {
      lanes: t.lanes,
      firstContext: t.firstContext
    }), l;
  }
  function ln(l, t, e, a, u, n) {
    var i = 0;
    if (a = l, typeof l == "function") qi(l) && (i = 1);
    else if (typeof l == "string")
      i = uv(
        l,
        e,
        B.current
      ) ? 26 : l === "html" || l === "head" || l === "body" ? 27 : 5;
    else
      l: switch (l) {
        case _t:
          return l = ct(31, e, t, u), l.elementType = _t, l.lanes = n, l;
        case Al:
          return qe(e.children, u, n, t);
        case Rl:
          i = 8, u |= 24;
          break;
        case q:
          return l = ct(12, e, t, u | 2), l.elementType = q, l.lanes = n, l;
        case Ot:
          return l = ct(13, e, t, u), l.elementType = Ot, l.lanes = n, l;
        case Kl:
          return l = ct(19, e, t, u), l.elementType = Kl, l.lanes = n, l;
        default:
          if (typeof l == "object" && l !== null)
            switch (l.$$typeof) {
              case El:
                i = 10;
                break l;
              case K:
                i = 9;
                break l;
              case Xl:
                i = 11;
                break l;
              case tl:
                i = 14;
                break l;
              case Jl:
                i = 16, a = null;
                break l;
            }
          i = 29, e = Error(
            o(130, l === null ? "null" : typeof l, "")
          ), a = null;
      }
    return t = ct(i, e, t, u), t.elementType = l, t.type = a, t.lanes = n, t;
  }
  function qe(l, t, e, a) {
    return l = ct(7, l, a, t), l.lanes = e, l;
  }
  function Bi(l, t, e) {
    return l = ct(6, l, null, t), l.lanes = e, l;
  }
  function Ds(l) {
    var t = ct(18, null, null, 0);
    return t.stateNode = l, t;
  }
  function Yi(l, t, e) {
    return t = ct(
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
  var Us = /* @__PURE__ */ new WeakMap();
  function yt(l, t) {
    if (typeof l == "object" && l !== null) {
      var e = Us.get(l);
      return e !== void 0 ? e : (t = {
        value: l,
        source: t,
        stack: Df(t)
      }, Us.set(l, t), t);
    }
    return {
      value: l,
      source: t,
      stack: Df(t)
    };
  }
  var oa = [], da = 0, tn = null, Fa = 0, gt = [], St = 0, ue = null, Dt = 1, Ut = "";
  function Xt(l, t) {
    oa[da++] = Fa, oa[da++] = tn, tn = l, Fa = t;
  }
  function Cs(l, t, e) {
    gt[St++] = Dt, gt[St++] = Ut, gt[St++] = ue, ue = l;
    var a = Dt;
    l = Ut;
    var u = 32 - nt(a) - 1;
    a &= ~(1 << u), e += 1;
    var n = 32 - nt(t) + u;
    if (30 < n) {
      var i = u - u % 5;
      n = (a & (1 << i) - 1).toString(32), a >>= i, u -= i, Dt = 1 << 32 - nt(t) + u | e << u | a, Ut = n + l;
    } else
      Dt = 1 << n | e << u | a, Ut = l;
  }
  function Gi(l) {
    l.return !== null && (Xt(l, 1), Cs(l, 1, 0));
  }
  function Xi(l) {
    for (; l === tn; )
      tn = oa[--da], oa[da] = null, Fa = oa[--da], oa[da] = null;
    for (; l === ue; )
      ue = gt[--St], gt[St] = null, Ut = gt[--St], gt[St] = null, Dt = gt[--St], gt[St] = null;
  }
  function Rs(l, t) {
    gt[St++] = Dt, gt[St++] = Ut, gt[St++] = ue, Dt = t.id, Ut = t.overflow, ue = l;
  }
  var ql = null, vl = null, el = !1, ne = null, bt = !1, Qi = Error(o(519));
  function ie(l) {
    var t = Error(
      o(
        418,
        1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML",
        ""
      )
    );
    throw Ia(yt(t, l)), Qi;
  }
  function Hs(l) {
    var t = l.stateNode, e = l.type, a = l.memoizedProps;
    switch (t[Hl] = l, t[$l] = a, e) {
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
        for (e = 0; e < pu.length; e++)
          I(pu[e], t);
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
        I("invalid", t), $f(
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
        I("invalid", t), kf(t, a.value, a.defaultValue, a.children);
    }
    e = a.children, typeof e != "string" && typeof e != "number" && typeof e != "bigint" || t.textContent === "" + e || a.suppressHydrationWarning === !0 || Pd(t.textContent, e) ? (a.popover != null && (I("beforetoggle", t), I("toggle", t)), a.onScroll != null && I("scroll", t), a.onScrollEnd != null && I("scrollend", t), a.onClick != null && (t.onclick = Bt), t = !0) : t = !1, t || ie(l, !0);
  }
  function qs(l) {
    for (ql = l.return; ql; )
      switch (ql.tag) {
        case 5:
        case 31:
        case 13:
          bt = !1;
          return;
        case 27:
        case 3:
          bt = !0;
          return;
        default:
          ql = ql.return;
      }
  }
  function ra(l) {
    if (l !== ql) return !1;
    if (!el) return qs(l), el = !0, !1;
    var t = l.tag, e;
    if ((e = t !== 3 && t !== 27) && ((e = t === 5) && (e = l.type, e = !(e !== "form" && e !== "button") || nf(l.type, l.memoizedProps)), e = !e), e && vl && ie(l), qs(l), t === 13) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(317));
      vl = fr(l);
    } else if (t === 31) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(317));
      vl = fr(l);
    } else
      t === 27 ? (t = vl, pe(l.type) ? (l = df, df = null, vl = l) : vl = t) : vl = ql ? jt(l.stateNode.nextSibling) : null;
    return !0;
  }
  function Be() {
    vl = ql = null, el = !1;
  }
  function Li() {
    var l = ne;
    return l !== null && (Pl === null ? Pl = l : Pl.push.apply(
      Pl,
      l
    ), ne = null), l;
  }
  function Ia(l) {
    ne === null ? ne = [l] : ne.push(l);
  }
  var Zi = r(null), Ye = null, Qt = null;
  function ce(l, t, e) {
    R(Zi, t._currentValue), t._currentValue = e;
  }
  function Lt(l) {
    l._currentValue = Zi.current, E(Zi);
  }
  function Vi(l, t, e) {
    for (; l !== null; ) {
      var a = l.alternate;
      if ((l.childLanes & t) !== t ? (l.childLanes |= t, a !== null && (a.childLanes |= t)) : a !== null && (a.childLanes & t) !== t && (a.childLanes |= t), l === e) break;
      l = l.return;
    }
  }
  function Ki(l, t, e, a) {
    var u = l.child;
    for (u !== null && (u.return = l); u !== null; ) {
      var n = u.dependencies;
      if (n !== null) {
        var i = u.child;
        n = n.firstContext;
        l: for (; n !== null; ) {
          var f = n;
          n = u;
          for (var s = 0; s < t.length; s++)
            if (f.context === t[s]) {
              n.lanes |= e, f = n.alternate, f !== null && (f.lanes |= e), Vi(
                n.return,
                e,
                l
              ), a || (i = null);
              break l;
            }
          n = f.next;
        }
      } else if (u.tag === 18) {
        if (i = u.return, i === null) throw Error(o(341));
        i.lanes |= e, n = i.alternate, n !== null && (n.lanes |= e), Vi(i, e, l), i = null;
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
        if (i === null) throw Error(o(387));
        if (i = i.memoizedProps, i !== null) {
          var f = u.type;
          it(u.pendingProps.value, i.value) || (l !== null ? l.push(f) : l = [f]);
        }
      } else if (u === il.current) {
        if (i = u.alternate, i === null) throw Error(o(387));
        i.memoizedState.memoizedState !== u.memoizedState.memoizedState && (l !== null ? l.push(xu) : l = [xu]);
      }
      u = u.return;
    }
    l !== null && Ki(
      t,
      l,
      e,
      a
    ), t.flags |= 262144;
  }
  function en(l) {
    for (l = l.firstContext; l !== null; ) {
      if (!it(
        l.context._currentValue,
        l.memoizedValue
      ))
        return !0;
      l = l.next;
    }
    return !1;
  }
  function Ge(l) {
    Ye = l, Qt = null, l = l.dependencies, l !== null && (l.firstContext = null);
  }
  function Bl(l) {
    return Bs(Ye, l);
  }
  function an(l, t) {
    return Ye === null && Ge(l), Bs(l, t);
  }
  function Bs(l, t) {
    var e = t._currentValue;
    if (t = { context: t, memoizedValue: e, next: null }, Qt === null) {
      if (l === null) throw Error(o(308));
      Qt = t, l.dependencies = { lanes: 0, firstContext: t }, l.flags |= 524288;
    } else Qt = Qt.next = t;
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
  }, th = m.unstable_scheduleCallback, eh = m.unstable_NormalPriority, Nl = {
    $$typeof: El,
    Consumer: null,
    Provider: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0
  };
  function Ji() {
    return {
      controller: new lh(),
      data: /* @__PURE__ */ new Map(),
      refCount: 0
    };
  }
  function Pa(l) {
    l.refCount--, l.refCount === 0 && th(eh, function() {
      l.controller.abort();
    });
  }
  var lu = null, wi = 0, ha = 0, va = null;
  function ah(l, t) {
    if (lu === null) {
      var e = lu = [];
      wi = 0, ha = kc(), va = {
        status: "pending",
        value: void 0,
        then: function(a) {
          e.push(a);
        }
      };
    }
    return wi++, t.then(Ys, Ys), t;
  }
  function Ys() {
    if (--wi === 0 && lu !== null) {
      va !== null && (va.status = "fulfilled");
      var l = lu;
      lu = null, ha = 0, va = null;
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
  var Gs = j.S;
  j.S = function(l, t) {
    zd = at(), typeof t == "object" && t !== null && typeof t.then == "function" && ah(l, t), Gs !== null && Gs(l, t);
  };
  var Xe = r(null);
  function $i() {
    var l = Xe.current;
    return l !== null ? l : hl.pooledCache;
  }
  function un(l, t) {
    t === null ? R(Xe, Xe.current) : R(Xe, t.pool);
  }
  function Xs() {
    var l = $i();
    return l === null ? null : { parent: Nl._currentValue, pool: l };
  }
  var ya = Error(o(460)), Wi = Error(o(474)), nn = Error(o(542)), cn = { then: function() {
  } };
  function Qs(l) {
    return l = l.status, l === "fulfilled" || l === "rejected";
  }
  function Ls(l, t, e) {
    switch (e = l[e], e === void 0 ? l.push(t) : e !== t && (t.then(Bt, Bt), t = e), t.status) {
      case "fulfilled":
        return t.value;
      case "rejected":
        throw l = t.reason, Vs(l), l;
      default:
        if (typeof t.status == "string") t.then(Bt, Bt);
        else {
          if (l = hl, l !== null && 100 < l.shellSuspendCounter)
            throw Error(o(482));
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
            throw l = t.reason, Vs(l), l;
        }
        throw Le = t, ya;
    }
  }
  function Qe(l) {
    try {
      var t = l._init;
      return t(l._payload);
    } catch (e) {
      throw e !== null && typeof e == "object" && typeof e.then == "function" ? (Le = e, ya) : e;
    }
  }
  var Le = null;
  function Zs() {
    if (Le === null) throw Error(o(459));
    var l = Le;
    return Le = null, l;
  }
  function Vs(l) {
    if (l === ya || l === nn)
      throw Error(o(483));
  }
  var ga = null, tu = 0;
  function fn(l) {
    var t = tu;
    return tu += 1, ga === null && (ga = []), Ls(ga, l, t);
  }
  function eu(l, t) {
    t = t.props.ref, l.ref = t !== void 0 ? t : null;
  }
  function sn(l, t) {
    throw t.$$typeof === N ? Error(o(525)) : (l = Object.prototype.toString.call(t), Error(
      o(
        31,
        l === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : l
      )
    ));
  }
  function Ks(l) {
    function t(h, d) {
      if (l) {
        var v = h.deletions;
        v === null ? (h.deletions = [d], h.flags |= 16) : v.push(d);
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
      return h = Gt(h, d), h.index = 0, h.sibling = null, h;
    }
    function n(h, d, v) {
      return h.index = v, l ? (v = h.alternate, v !== null ? (v = v.index, v < d ? (h.flags |= 67108866, d) : v) : (h.flags |= 67108866, d)) : (h.flags |= 1048576, d);
    }
    function i(h) {
      return l && h.alternate === null && (h.flags |= 67108866), h;
    }
    function f(h, d, v, z) {
      return d === null || d.tag !== 6 ? (d = Bi(v, h.mode, z), d.return = h, d) : (d = u(d, v), d.return = h, d);
    }
    function s(h, d, v, z) {
      var X = v.type;
      return X === Al ? b(
        h,
        d,
        v.props.children,
        z,
        v.key
      ) : d !== null && (d.elementType === X || typeof X == "object" && X !== null && X.$$typeof === Jl && Qe(X) === d.type) ? (d = u(d, v.props), eu(d, v), d.return = h, d) : (d = ln(
        v.type,
        v.key,
        v.props,
        null,
        h.mode,
        z
      ), eu(d, v), d.return = h, d);
    }
    function y(h, d, v, z) {
      return d === null || d.tag !== 4 || d.stateNode.containerInfo !== v.containerInfo || d.stateNode.implementation !== v.implementation ? (d = Yi(v, h.mode, z), d.return = h, d) : (d = u(d, v.children || []), d.return = h, d);
    }
    function b(h, d, v, z, X) {
      return d === null || d.tag !== 7 ? (d = qe(
        v,
        h.mode,
        z,
        X
      ), d.return = h, d) : (d = u(d, v), d.return = h, d);
    }
    function T(h, d, v) {
      if (typeof d == "string" && d !== "" || typeof d == "number" || typeof d == "bigint")
        return d = Bi(
          "" + d,
          h.mode,
          v
        ), d.return = h, d;
      if (typeof d == "object" && d !== null) {
        switch (d.$$typeof) {
          case G:
            return v = ln(
              d.type,
              d.key,
              d.props,
              null,
              h.mode,
              v
            ), eu(v, d), v.return = h, v;
          case jl:
            return d = Yi(
              d,
              h.mode,
              v
            ), d.return = h, d;
          case Jl:
            return d = Qe(d), T(h, d, v);
        }
        if (Tt(d) || wl(d))
          return d = qe(
            d,
            h.mode,
            v,
            null
          ), d.return = h, d;
        if (typeof d.then == "function")
          return T(h, fn(d), v);
        if (d.$$typeof === El)
          return T(
            h,
            an(h, d),
            v
          );
        sn(h, d);
      }
      return null;
    }
    function g(h, d, v, z) {
      var X = d !== null ? d.key : null;
      if (typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint")
        return X !== null ? null : f(h, d, "" + v, z);
      if (typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case G:
            return v.key === X ? s(h, d, v, z) : null;
          case jl:
            return v.key === X ? y(h, d, v, z) : null;
          case Jl:
            return v = Qe(v), g(h, d, v, z);
        }
        if (Tt(v) || wl(v))
          return X !== null ? null : b(h, d, v, z, null);
        if (typeof v.then == "function")
          return g(
            h,
            d,
            fn(v),
            z
          );
        if (v.$$typeof === El)
          return g(
            h,
            d,
            an(h, v),
            z
          );
        sn(h, v);
      }
      return null;
    }
    function S(h, d, v, z, X) {
      if (typeof z == "string" && z !== "" || typeof z == "number" || typeof z == "bigint")
        return h = h.get(v) || null, f(d, h, "" + z, X);
      if (typeof z == "object" && z !== null) {
        switch (z.$$typeof) {
          case G:
            return h = h.get(
              z.key === null ? v : z.key
            ) || null, s(d, h, z, X);
          case jl:
            return h = h.get(
              z.key === null ? v : z.key
            ) || null, y(d, h, z, X);
          case Jl:
            return z = Qe(z), S(
              h,
              d,
              v,
              z,
              X
            );
        }
        if (Tt(z) || wl(z))
          return h = h.get(v) || null, b(d, h, z, X, null);
        if (typeof z.then == "function")
          return S(
            h,
            d,
            v,
            fn(z),
            X
          );
        if (z.$$typeof === El)
          return S(
            h,
            d,
            v,
            an(d, z),
            X
          );
        sn(d, z);
      }
      return null;
    }
    function H(h, d, v, z) {
      for (var X = null, al = null, Y = d, W = d = 0, ll = null; Y !== null && W < v.length; W++) {
        Y.index > W ? (ll = Y, Y = null) : ll = Y.sibling;
        var ul = g(
          h,
          Y,
          v[W],
          z
        );
        if (ul === null) {
          Y === null && (Y = ll);
          break;
        }
        l && Y && ul.alternate === null && t(h, Y), d = n(ul, d, W), al === null ? X = ul : al.sibling = ul, al = ul, Y = ll;
      }
      if (W === v.length)
        return e(h, Y), el && Xt(h, W), X;
      if (Y === null) {
        for (; W < v.length; W++)
          Y = T(h, v[W], z), Y !== null && (d = n(
            Y,
            d,
            W
          ), al === null ? X = Y : al.sibling = Y, al = Y);
        return el && Xt(h, W), X;
      }
      for (Y = a(Y); W < v.length; W++)
        ll = S(
          Y,
          h,
          W,
          v[W],
          z
        ), ll !== null && (l && ll.alternate !== null && Y.delete(
          ll.key === null ? W : ll.key
        ), d = n(
          ll,
          d,
          W
        ), al === null ? X = ll : al.sibling = ll, al = ll);
      return l && Y.forEach(function(xe) {
        return t(h, xe);
      }), el && Xt(h, W), X;
    }
    function Q(h, d, v, z) {
      if (v == null) throw Error(o(151));
      for (var X = null, al = null, Y = d, W = d = 0, ll = null, ul = v.next(); Y !== null && !ul.done; W++, ul = v.next()) {
        Y.index > W ? (ll = Y, Y = null) : ll = Y.sibling;
        var xe = g(h, Y, ul.value, z);
        if (xe === null) {
          Y === null && (Y = ll);
          break;
        }
        l && Y && xe.alternate === null && t(h, Y), d = n(xe, d, W), al === null ? X = xe : al.sibling = xe, al = xe, Y = ll;
      }
      if (ul.done)
        return e(h, Y), el && Xt(h, W), X;
      if (Y === null) {
        for (; !ul.done; W++, ul = v.next())
          ul = T(h, ul.value, z), ul !== null && (d = n(ul, d, W), al === null ? X = ul : al.sibling = ul, al = ul);
        return el && Xt(h, W), X;
      }
      for (Y = a(Y); !ul.done; W++, ul = v.next())
        ul = S(Y, h, W, ul.value, z), ul !== null && (l && ul.alternate !== null && Y.delete(ul.key === null ? W : ul.key), d = n(ul, d, W), al === null ? X = ul : al.sibling = ul, al = ul);
      return l && Y.forEach(function(vv) {
        return t(h, vv);
      }), el && Xt(h, W), X;
    }
    function rl(h, d, v, z) {
      if (typeof v == "object" && v !== null && v.type === Al && v.key === null && (v = v.props.children), typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case G:
            l: {
              for (var X = v.key; d !== null; ) {
                if (d.key === X) {
                  if (X = v.type, X === Al) {
                    if (d.tag === 7) {
                      e(
                        h,
                        d.sibling
                      ), z = u(
                        d,
                        v.props.children
                      ), z.return = h, h = z;
                      break l;
                    }
                  } else if (d.elementType === X || typeof X == "object" && X !== null && X.$$typeof === Jl && Qe(X) === d.type) {
                    e(
                      h,
                      d.sibling
                    ), z = u(d, v.props), eu(z, v), z.return = h, h = z;
                    break l;
                  }
                  e(h, d);
                  break;
                } else t(h, d);
                d = d.sibling;
              }
              v.type === Al ? (z = qe(
                v.props.children,
                h.mode,
                z,
                v.key
              ), z.return = h, h = z) : (z = ln(
                v.type,
                v.key,
                v.props,
                null,
                h.mode,
                z
              ), eu(z, v), z.return = h, h = z);
            }
            return i(h);
          case jl:
            l: {
              for (X = v.key; d !== null; ) {
                if (d.key === X)
                  if (d.tag === 4 && d.stateNode.containerInfo === v.containerInfo && d.stateNode.implementation === v.implementation) {
                    e(
                      h,
                      d.sibling
                    ), z = u(d, v.children || []), z.return = h, h = z;
                    break l;
                  } else {
                    e(h, d);
                    break;
                  }
                else t(h, d);
                d = d.sibling;
              }
              z = Yi(v, h.mode, z), z.return = h, h = z;
            }
            return i(h);
          case Jl:
            return v = Qe(v), rl(
              h,
              d,
              v,
              z
            );
        }
        if (Tt(v))
          return H(
            h,
            d,
            v,
            z
          );
        if (wl(v)) {
          if (X = wl(v), typeof X != "function") throw Error(o(150));
          return v = X.call(v), Q(
            h,
            d,
            v,
            z
          );
        }
        if (typeof v.then == "function")
          return rl(
            h,
            d,
            fn(v),
            z
          );
        if (v.$$typeof === El)
          return rl(
            h,
            d,
            an(h, v),
            z
          );
        sn(h, v);
      }
      return typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint" ? (v = "" + v, d !== null && d.tag === 6 ? (e(h, d.sibling), z = u(d, v), z.return = h, h = z) : (e(h, d), z = Bi(v, h.mode, z), z.return = h, h = z), i(h)) : e(h, d);
    }
    return function(h, d, v, z) {
      try {
        tu = 0;
        var X = rl(
          h,
          d,
          v,
          z
        );
        return ga = null, X;
      } catch (Y) {
        if (Y === ya || Y === nn) throw Y;
        var al = ct(29, Y, null, h.mode);
        return al.lanes = z, al.return = h, al;
      }
    };
  }
  var Ze = Ks(!0), Js = Ks(!1), fe = !1;
  function ki(l) {
    l.updateQueue = {
      baseState: l.memoizedState,
      firstBaseUpdate: null,
      lastBaseUpdate: null,
      shared: { pending: null, lanes: 0, hiddenCallbacks: null },
      callbacks: null
    };
  }
  function Fi(l, t) {
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
      return u === null ? t.next = t : (t.next = u.next, u.next = t), a.pending = t, t = Pu(l), _s(l, null, e), t;
    }
    return Iu(l, a, t, e), Pu(l);
  }
  function au(l, t, e) {
    if (t = t.updateQueue, t !== null && (t = t.shared, (e & 4194048) !== 0)) {
      var a = t.lanes;
      a &= l.pendingLanes, e |= a, t.lanes = e, Bf(l, e);
    }
  }
  function Ii(l, t) {
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
  var Pi = !1;
  function uu() {
    if (Pi) {
      var l = va;
      if (l !== null) throw l;
    }
  }
  function nu(l, t, e, a) {
    Pi = !1;
    var u = l.updateQueue;
    fe = !1;
    var n = u.firstBaseUpdate, i = u.lastBaseUpdate, f = u.shared.pending;
    if (f !== null) {
      u.shared.pending = null;
      var s = f, y = s.next;
      s.next = null, i === null ? n = y : i.next = y, i = s;
      var b = l.alternate;
      b !== null && (b = b.updateQueue, f = b.lastBaseUpdate, f !== i && (f === null ? b.firstBaseUpdate = y : f.next = y, b.lastBaseUpdate = s));
    }
    if (n !== null) {
      var T = u.baseState;
      i = 0, b = y = s = null, f = n;
      do {
        var g = f.lane & -536870913, S = g !== f.lane;
        if (S ? (P & g) === g : (a & g) === g) {
          g !== 0 && g === ha && (Pi = !0), b !== null && (b = b.next = {
            lane: 0,
            tag: f.tag,
            payload: f.payload,
            callback: null,
            next: null
          });
          l: {
            var H = l, Q = f;
            g = t;
            var rl = e;
            switch (Q.tag) {
              case 1:
                if (H = Q.payload, typeof H == "function") {
                  T = H.call(rl, T, g);
                  break l;
                }
                T = H;
                break l;
              case 3:
                H.flags = H.flags & -65537 | 128;
              case 0:
                if (H = Q.payload, g = typeof H == "function" ? H.call(rl, T, g) : H, g == null) break l;
                T = A({}, T, g);
                break l;
              case 2:
                fe = !0;
            }
          }
          g = f.callback, g !== null && (l.flags |= 64, S && (l.flags |= 8192), S = u.callbacks, S === null ? u.callbacks = [g] : S.push(g));
        } else
          S = {
            lane: g,
            tag: f.tag,
            payload: f.payload,
            callback: f.callback,
            next: null
          }, b === null ? (y = b = S, s = T) : b = b.next = S, i |= g;
        if (f = f.next, f === null) {
          if (f = u.shared.pending, f === null)
            break;
          S = f, f = S.next, S.next = null, u.lastBaseUpdate = S, u.shared.pending = null;
        }
      } while (!0);
      b === null && (s = T), u.baseState = s, u.firstBaseUpdate = y, u.lastBaseUpdate = b, n === null && (u.shared.lanes = 0), ve |= i, l.lanes = i, l.memoizedState = T;
    }
  }
  function ws(l, t) {
    if (typeof l != "function")
      throw Error(o(191, l));
    l.call(t);
  }
  function $s(l, t) {
    var e = l.callbacks;
    if (e !== null)
      for (l.callbacks = null, l = 0; l < e.length; l++)
        ws(e[l], t);
  }
  var Sa = r(null), on = r(0);
  function Ws(l, t) {
    l = Ft, R(on, l), R(Sa, t), Ft = l | t.baseLanes;
  }
  function lc() {
    R(on, Ft), R(Sa, Sa.current);
  }
  function tc() {
    Ft = on.current, E(Sa), E(on);
  }
  var ft = r(null), pt = null;
  function de(l) {
    var t = l.alternate;
    R(Tl, Tl.current & 1), R(ft, l), pt === null && (t === null || Sa.current !== null || t.memoizedState !== null) && (pt = l);
  }
  function ec(l) {
    R(Tl, Tl.current), R(ft, l), pt === null && (pt = l);
  }
  function ks(l) {
    l.tag === 22 ? (R(Tl, Tl.current), R(ft, l), pt === null && (pt = l)) : re();
  }
  function re() {
    R(Tl, Tl.current), R(ft, ft.current);
  }
  function st(l) {
    E(ft), pt === l && (pt = null), E(Tl);
  }
  var Tl = r(0);
  function dn(l) {
    for (var t = l; t !== null; ) {
      if (t.tag === 13) {
        var e = t.memoizedState;
        if (e !== null && (e = e.dehydrated, e === null || sf(e) || of(e)))
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
  var Zt = 0, $ = null, ol = null, Ol = null, rn = !1, ba = !1, Ve = !1, mn = 0, iu = 0, pa = null, nh = 0;
  function bl() {
    throw Error(o(321));
  }
  function ac(l, t) {
    if (t === null) return !1;
    for (var e = 0; e < t.length && e < l.length; e++)
      if (!it(l[e], t[e])) return !1;
    return !0;
  }
  function uc(l, t, e, a, u, n) {
    return Zt = n, $ = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, j.H = l === null || l.memoizedState === null ? Ro : bc, Ve = !1, n = e(a, u), Ve = !1, ba && (n = Is(
      t,
      e,
      a,
      u
    )), Fs(l), n;
  }
  function Fs(l) {
    j.H = su;
    var t = ol !== null && ol.next !== null;
    if (Zt = 0, Ol = ol = $ = null, rn = !1, iu = 0, pa = null, t) throw Error(o(300));
    l === null || _l || (l = l.dependencies, l !== null && en(l) && (_l = !0));
  }
  function Is(l, t, e, a) {
    $ = l;
    var u = 0;
    do {
      if (ba && (pa = null), iu = 0, ba = !1, 25 <= u) throw Error(o(301));
      if (u += 1, Ol = ol = null, l.updateQueue != null) {
        var n = l.updateQueue;
        n.lastEffect = null, n.events = null, n.stores = null, n.memoCache != null && (n.memoCache.index = 0);
      }
      j.H = Ho, n = t(e, a);
    } while (ba);
    return n;
  }
  function ih() {
    var l = j.H, t = l.useState()[0];
    return t = typeof t.then == "function" ? cu(t) : t, l = l.useState()[0], (ol !== null ? ol.memoizedState : null) !== l && ($.flags |= 1024), t;
  }
  function nc() {
    var l = mn !== 0;
    return mn = 0, l;
  }
  function ic(l, t, e) {
    t.updateQueue = l.updateQueue, t.flags &= -2053, l.lanes &= ~e;
  }
  function cc(l) {
    if (rn) {
      for (l = l.memoizedState; l !== null; ) {
        var t = l.queue;
        t !== null && (t.pending = null), l = l.next;
      }
      rn = !1;
    }
    Zt = 0, Ol = ol = $ = null, ba = !1, iu = mn = 0, pa = null;
  }
  function Vl() {
    var l = {
      memoizedState: null,
      baseState: null,
      baseQueue: null,
      queue: null,
      next: null
    };
    return Ol === null ? $.memoizedState = Ol = l : Ol = Ol.next = l, Ol;
  }
  function xl() {
    if (ol === null) {
      var l = $.alternate;
      l = l !== null ? l.memoizedState : null;
    } else l = ol.next;
    var t = Ol === null ? $.memoizedState : Ol.next;
    if (t !== null)
      Ol = t, ol = l;
    else {
      if (l === null)
        throw $.alternate === null ? Error(o(467)) : Error(o(310));
      ol = l, l = {
        memoizedState: ol.memoizedState,
        baseState: ol.baseState,
        baseQueue: ol.baseQueue,
        queue: ol.queue,
        next: null
      }, Ol === null ? $.memoizedState = Ol = l : Ol = Ol.next = l;
    }
    return Ol;
  }
  function hn() {
    return { lastEffect: null, events: null, stores: null, memoCache: null };
  }
  function cu(l) {
    var t = iu;
    return iu += 1, pa === null && (pa = []), l = Ls(pa, l, t), t = $, (Ol === null ? t.memoizedState : Ol.next) === null && (t = t.alternate, j.H = t === null || t.memoizedState === null ? Ro : bc), l;
  }
  function vn(l) {
    if (l !== null && typeof l == "object") {
      if (typeof l.then == "function") return cu(l);
      if (l.$$typeof === El) return Bl(l);
    }
    throw Error(o(438, String(l)));
  }
  function fc(l) {
    var t = null, e = $.updateQueue;
    if (e !== null && (t = e.memoCache), t == null) {
      var a = $.alternate;
      a !== null && (a = a.updateQueue, a !== null && (a = a.memoCache, a != null && (t = {
        data: a.data.map(function(u) {
          return u.slice();
        }),
        index: 0
      })));
    }
    if (t == null && (t = { data: [], index: 0 }), e === null && (e = hn(), $.updateQueue = e), e.memoCache = t, e = t.data[t.index], e === void 0)
      for (e = t.data[t.index] = Array(l), a = 0; a < l; a++)
        e[a] = We;
    return t.index++, e;
  }
  function Vt(l, t) {
    return typeof t == "function" ? t(l) : t;
  }
  function yn(l) {
    var t = xl();
    return sc(t, ol, l);
  }
  function sc(l, t, e) {
    var a = l.queue;
    if (a === null) throw Error(o(311));
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
      var f = i = null, s = null, y = t, b = !1;
      do {
        var T = y.lane & -536870913;
        if (T !== y.lane ? (P & T) === T : (Zt & T) === T) {
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
            }), T === ha && (b = !0);
          else if ((Zt & g) === g) {
            y = y.next, g === ha && (b = !0);
            continue;
          } else
            T = {
              lane: 0,
              revertLane: y.revertLane,
              gesture: null,
              action: y.action,
              hasEagerState: y.hasEagerState,
              eagerState: y.eagerState,
              next: null
            }, s === null ? (f = s = T, i = n) : s = s.next = T, $.lanes |= g, ve |= g;
          T = y.action, Ve && e(n, T), n = y.hasEagerState ? y.eagerState : e(n, T);
        } else
          g = {
            lane: T,
            revertLane: y.revertLane,
            gesture: y.gesture,
            action: y.action,
            hasEagerState: y.hasEagerState,
            eagerState: y.eagerState,
            next: null
          }, s === null ? (f = s = g, i = n) : s = s.next = g, $.lanes |= T, ve |= T;
        y = y.next;
      } while (y !== null && y !== t);
      if (s === null ? i = n : s.next = f, !it(n, l.memoizedState) && (_l = !0, b && (e = va, e !== null)))
        throw e;
      l.memoizedState = n, l.baseState = i, l.baseQueue = s, a.lastRenderedState = n;
    }
    return u === null && (a.lanes = 0), [l.memoizedState, a.dispatch];
  }
  function oc(l) {
    var t = xl(), e = t.queue;
    if (e === null) throw Error(o(311));
    e.lastRenderedReducer = l;
    var a = e.dispatch, u = e.pending, n = t.memoizedState;
    if (u !== null) {
      e.pending = null;
      var i = u = u.next;
      do
        n = l(n, i.action), i = i.next;
      while (i !== u);
      it(n, t.memoizedState) || (_l = !0), t.memoizedState = n, t.baseQueue === null && (t.baseState = n), e.lastRenderedState = n;
    }
    return [n, a];
  }
  function Ps(l, t, e) {
    var a = $, u = xl(), n = el;
    if (n) {
      if (e === void 0) throw Error(o(407));
      e = e();
    } else e = t();
    var i = !it(
      (ol || u).memoizedState,
      e
    );
    if (i && (u.memoizedState = e, _l = !0), u = u.queue, mc(eo.bind(null, a, u, l), [
      l
    ]), u.getSnapshot !== t || i || Ol !== null && Ol.memoizedState.tag & 1) {
      if (a.flags |= 2048, ja(
        9,
        { destroy: void 0 },
        to.bind(
          null,
          a,
          u,
          e,
          t
        ),
        null
      ), hl === null) throw Error(o(349));
      n || (Zt & 127) !== 0 || lo(a, t, e);
    }
    return e;
  }
  function lo(l, t, e) {
    l.flags |= 16384, l = { getSnapshot: t, value: e }, t = $.updateQueue, t === null ? (t = hn(), $.updateQueue = t, t.stores = [l]) : (e = t.stores, e === null ? t.stores = [l] : e.push(l));
  }
  function to(l, t, e, a) {
    t.value = e, t.getSnapshot = a, ao(t) && uo(l);
  }
  function eo(l, t, e) {
    return e(function() {
      ao(t) && uo(l);
    });
  }
  function ao(l) {
    var t = l.getSnapshot;
    l = l.value;
    try {
      var e = t();
      return !it(l, e);
    } catch {
      return !0;
    }
  }
  function uo(l) {
    var t = He(l, 2);
    t !== null && lt(t, l, 2);
  }
  function dc(l) {
    var t = Vl();
    if (typeof l == "function") {
      var e = l;
      if (l = e(), Ve) {
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
  function no(l, t, e, a) {
    return l.baseState = e, sc(
      l,
      ol,
      typeof a == "function" ? a : Vt
    );
  }
  function ch(l, t, e, a, u) {
    if (bn(l)) throw Error(o(485));
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
      j.T !== null ? e(!0) : n.isTransition = !1, a(n), e = t.pending, e === null ? (n.next = t.pending = n, io(t, n)) : (n.next = e.next, t.pending = e.next = n);
    }
  }
  function io(l, t) {
    var e = t.action, a = t.payload, u = l.state;
    if (t.isTransition) {
      var n = j.T, i = {};
      j.T = i;
      try {
        var f = e(u, a), s = j.S;
        s !== null && s(i, f), co(l, t, f);
      } catch (y) {
        rc(l, t, y);
      } finally {
        n !== null && i.types !== null && (n.types = i.types), j.T = n;
      }
    } else
      try {
        n = e(u, a), co(l, t, n);
      } catch (y) {
        rc(l, t, y);
      }
  }
  function co(l, t, e) {
    e !== null && typeof e == "object" && typeof e.then == "function" ? e.then(
      function(a) {
        fo(l, t, a);
      },
      function(a) {
        return rc(l, t, a);
      }
    ) : fo(l, t, e);
  }
  function fo(l, t, e) {
    t.status = "fulfilled", t.value = e, so(t), l.state = e, t = l.pending, t !== null && (e = t.next, e === t ? l.pending = null : (e = e.next, t.next = e, io(l, e)));
  }
  function rc(l, t, e) {
    var a = l.pending;
    if (l.pending = null, a !== null) {
      a = a.next;
      do
        t.status = "rejected", t.reason = e, so(t), t = t.next;
      while (t !== a);
    }
    l.action = null;
  }
  function so(l) {
    l = l.listeners;
    for (var t = 0; t < l.length; t++) (0, l[t])();
  }
  function oo(l, t) {
    return t;
  }
  function ro(l, t) {
    if (el) {
      var e = hl.formState;
      if (e !== null) {
        l: {
          var a = $;
          if (el) {
            if (vl) {
              t: {
                for (var u = vl, n = bt; u.nodeType !== 8; ) {
                  if (!n) {
                    u = null;
                    break t;
                  }
                  if (u = jt(
                    u.nextSibling
                  ), u === null) {
                    u = null;
                    break t;
                  }
                }
                n = u.data, u = n === "F!" || n === "F" ? u : null;
              }
              if (u) {
                vl = jt(
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
      lastRenderedReducer: oo,
      lastRenderedState: t
    }, e.queue = a, e = Do.bind(
      null,
      $,
      a
    ), a.dispatch = e, a = dc(!1), n = Sc.bind(
      null,
      $,
      !1,
      a.queue
    ), a = Vl(), u = {
      state: t,
      dispatch: null,
      action: l,
      pending: null
    }, a.queue = u, e = ch.bind(
      null,
      $,
      u,
      n,
      e
    ), u.dispatch = e, a.memoizedState = l, [t, e, !1];
  }
  function mo(l) {
    var t = xl();
    return ho(t, ol, l);
  }
  function ho(l, t, e) {
    if (t = sc(
      l,
      t,
      oo
    )[0], l = yn(Vt)[0], typeof t == "object" && t !== null && typeof t.then == "function")
      try {
        var a = cu(t);
      } catch (i) {
        throw i === ya ? nn : i;
      }
    else a = t;
    t = xl();
    var u = t.queue, n = u.dispatch;
    return e !== t.memoizedState && ($.flags |= 2048, ja(
      9,
      { destroy: void 0 },
      fh.bind(null, u, e),
      null
    )), [a, n, l];
  }
  function fh(l, t) {
    l.action = t;
  }
  function vo(l) {
    var t = xl(), e = ol;
    if (e !== null)
      return ho(t, e, l);
    xl(), t = t.memoizedState, e = xl();
    var a = e.queue.dispatch;
    return e.memoizedState = l, [t, a, !1];
  }
  function ja(l, t, e, a) {
    return l = { tag: l, create: e, deps: a, inst: t, next: null }, t = $.updateQueue, t === null && (t = hn(), $.updateQueue = t), e = t.lastEffect, e === null ? t.lastEffect = l.next = l : (a = e.next, e.next = l, l.next = a, t.lastEffect = l), l;
  }
  function yo() {
    return xl().memoizedState;
  }
  function gn(l, t, e, a) {
    var u = Vl();
    $.flags |= l, u.memoizedState = ja(
      1 | t,
      { destroy: void 0 },
      e,
      a === void 0 ? null : a
    );
  }
  function Sn(l, t, e, a) {
    var u = xl();
    a = a === void 0 ? null : a;
    var n = u.memoizedState.inst;
    ol !== null && a !== null && ac(a, ol.memoizedState.deps) ? u.memoizedState = ja(t, n, e, a) : ($.flags |= l, u.memoizedState = ja(
      1 | t,
      n,
      e,
      a
    ));
  }
  function go(l, t) {
    gn(8390656, 8, l, t);
  }
  function mc(l, t) {
    Sn(2048, 8, l, t);
  }
  function sh(l) {
    $.flags |= 4;
    var t = $.updateQueue;
    if (t === null)
      t = hn(), $.updateQueue = t, t.events = [l];
    else {
      var e = t.events;
      e === null ? t.events = [l] : e.push(l);
    }
  }
  function So(l) {
    var t = xl().memoizedState;
    return sh({ ref: t, nextImpl: l }), function() {
      if ((nl & 2) !== 0) throw Error(o(440));
      return t.impl.apply(void 0, arguments);
    };
  }
  function bo(l, t) {
    return Sn(4, 2, l, t);
  }
  function po(l, t) {
    return Sn(4, 4, l, t);
  }
  function jo(l, t) {
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
    e = e != null ? e.concat([l]) : null, Sn(4, 4, jo.bind(null, t, l), e);
  }
  function hc() {
  }
  function zo(l, t) {
    var e = xl();
    t = t === void 0 ? null : t;
    var a = e.memoizedState;
    return t !== null && ac(t, a[1]) ? a[0] : (e.memoizedState = [l, t], l);
  }
  function To(l, t) {
    var e = xl();
    t = t === void 0 ? null : t;
    var a = e.memoizedState;
    if (t !== null && ac(t, a[1]))
      return a[0];
    if (a = l(), Ve) {
      te(!0);
      try {
        l();
      } finally {
        te(!1);
      }
    }
    return e.memoizedState = [a, t], a;
  }
  function vc(l, t, e) {
    return e === void 0 || (Zt & 1073741824) !== 0 && (P & 261930) === 0 ? l.memoizedState = t : (l.memoizedState = e, l = xd(), $.lanes |= l, ve |= l, e);
  }
  function xo(l, t, e, a) {
    return it(e, t) ? e : Sa.current !== null ? (l = vc(l, e, a), it(l, t) || (_l = !0), l) : (Zt & 42) === 0 || (Zt & 1073741824) !== 0 && (P & 261930) === 0 ? (_l = !0, l.memoizedState = e) : (l = xd(), $.lanes |= l, ve |= l, t);
  }
  function Eo(l, t, e, a, u) {
    var n = U.p;
    U.p = n !== 0 && 8 > n ? n : 8;
    var i = j.T, f = {};
    j.T = f, Sc(l, !1, t, e);
    try {
      var s = u(), y = j.S;
      if (y !== null && y(f, s), s !== null && typeof s == "object" && typeof s.then == "function") {
        var b = uh(
          s,
          a
        );
        fu(
          l,
          t,
          b,
          rt(l)
        );
      } else
        fu(
          l,
          t,
          a,
          rt(l)
        );
    } catch (T) {
      fu(
        l,
        t,
        { then: function() {
        }, status: "rejected", reason: T },
        rt()
      );
    } finally {
      U.p = n, i !== null && f.types !== null && (i.types = f.types), j.T = i;
    }
  }
  function oh() {
  }
  function yc(l, t, e, a) {
    if (l.tag !== 5) throw Error(o(476));
    var u = No(l).queue;
    Eo(
      l,
      u,
      t,
      Z,
      e === null ? oh : function() {
        return Oo(l), e(a);
      }
    );
  }
  function No(l) {
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
  function Oo(l) {
    var t = No(l);
    t.next === null && (t = l.alternate.memoizedState), fu(
      l,
      t.next.queue,
      {},
      rt()
    );
  }
  function gc() {
    return Bl(xu);
  }
  function _o() {
    return xl().memoizedState;
  }
  function Mo() {
    return xl().memoizedState;
  }
  function dh(l) {
    for (var t = l.return; t !== null; ) {
      switch (t.tag) {
        case 24:
        case 3:
          var e = rt();
          l = se(e);
          var a = oe(t, l, e);
          a !== null && (lt(a, t, e), au(a, t, e)), t = { cache: Ji() }, l.payload = t;
          return;
      }
      t = t.return;
    }
  }
  function rh(l, t, e) {
    var a = rt();
    e = {
      lane: a,
      revertLane: 0,
      gesture: null,
      action: e,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, bn(l) ? Uo(t, e) : (e = Hi(l, t, e, a), e !== null && (lt(e, l, a), Co(e, t, a)));
  }
  function Do(l, t, e) {
    var a = rt();
    fu(l, t, e, a);
  }
  function fu(l, t, e, a) {
    var u = {
      lane: a,
      revertLane: 0,
      gesture: null,
      action: e,
      hasEagerState: !1,
      eagerState: null,
      next: null
    };
    if (bn(l)) Uo(t, u);
    else {
      var n = l.alternate;
      if (l.lanes === 0 && (n === null || n.lanes === 0) && (n = t.lastRenderedReducer, n !== null))
        try {
          var i = t.lastRenderedState, f = n(i, e);
          if (u.hasEagerState = !0, u.eagerState = f, it(f, i))
            return Iu(l, t, u, 0), hl === null && Fu(), !1;
        } catch {
        }
      if (e = Hi(l, t, u, a), e !== null)
        return lt(e, l, a), Co(e, t, a), !0;
    }
    return !1;
  }
  function Sc(l, t, e, a) {
    if (a = {
      lane: 2,
      revertLane: kc(),
      gesture: null,
      action: a,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, bn(l)) {
      if (t) throw Error(o(479));
    } else
      t = Hi(
        l,
        e,
        a,
        2
      ), t !== null && lt(t, l, 2);
  }
  function bn(l) {
    var t = l.alternate;
    return l === $ || t !== null && t === $;
  }
  function Uo(l, t) {
    ba = rn = !0;
    var e = l.pending;
    e === null ? t.next = t : (t.next = e.next, e.next = t), l.pending = t;
  }
  function Co(l, t, e) {
    if ((e & 4194048) !== 0) {
      var a = t.lanes;
      a &= l.pendingLanes, e |= a, t.lanes = e, Bf(l, e);
    }
  }
  var su = {
    readContext: Bl,
    use: vn,
    useCallback: bl,
    useContext: bl,
    useEffect: bl,
    useImperativeHandle: bl,
    useLayoutEffect: bl,
    useInsertionEffect: bl,
    useMemo: bl,
    useReducer: bl,
    useRef: bl,
    useState: bl,
    useDebugValue: bl,
    useDeferredValue: bl,
    useTransition: bl,
    useSyncExternalStore: bl,
    useId: bl,
    useHostTransitionStatus: bl,
    useFormState: bl,
    useActionState: bl,
    useOptimistic: bl,
    useMemoCache: bl,
    useCacheRefresh: bl
  };
  su.useEffectEvent = bl;
  var Ro = {
    readContext: Bl,
    use: vn,
    useCallback: function(l, t) {
      return Vl().memoizedState = [
        l,
        t === void 0 ? null : t
      ], l;
    },
    useContext: Bl,
    useEffect: go,
    useImperativeHandle: function(l, t, e) {
      e = e != null ? e.concat([l]) : null, gn(
        4194308,
        4,
        jo.bind(null, t, l),
        e
      );
    },
    useLayoutEffect: function(l, t) {
      return gn(4194308, 4, l, t);
    },
    useInsertionEffect: function(l, t) {
      gn(4, 2, l, t);
    },
    useMemo: function(l, t) {
      var e = Vl();
      t = t === void 0 ? null : t;
      var a = l();
      if (Ve) {
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
        if (Ve) {
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
      }, a.queue = l, l = l.dispatch = rh.bind(
        null,
        $,
        l
      ), [a.memoizedState, l];
    },
    useRef: function(l) {
      var t = Vl();
      return l = { current: l }, t.memoizedState = l;
    },
    useState: function(l) {
      l = dc(l);
      var t = l.queue, e = Do.bind(null, $, t);
      return t.dispatch = e, [l.memoizedState, e];
    },
    useDebugValue: hc,
    useDeferredValue: function(l, t) {
      var e = Vl();
      return vc(e, l, t);
    },
    useTransition: function() {
      var l = dc(!1);
      return l = Eo.bind(
        null,
        $,
        l.queue,
        !0,
        !1
      ), Vl().memoizedState = l, [!1, l];
    },
    useSyncExternalStore: function(l, t, e) {
      var a = $, u = Vl();
      if (el) {
        if (e === void 0)
          throw Error(o(407));
        e = e();
      } else {
        if (e = t(), hl === null)
          throw Error(o(349));
        (P & 127) !== 0 || lo(a, t, e);
      }
      u.memoizedState = e;
      var n = { value: e, getSnapshot: t };
      return u.queue = n, go(eo.bind(null, a, n, l), [
        l
      ]), a.flags |= 2048, ja(
        9,
        { destroy: void 0 },
        to.bind(
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
      var l = Vl(), t = hl.identifierPrefix;
      if (el) {
        var e = Ut, a = Dt;
        e = (a & ~(1 << 32 - nt(a) - 1)).toString(32) + e, t = "_" + t + "R_" + e, e = mn++, 0 < e && (t += "H" + e.toString(32)), t += "_";
      } else
        e = nh++, t = "_" + t + "r_" + e.toString(32) + "_";
      return l.memoizedState = t;
    },
    useHostTransitionStatus: gc,
    useFormState: ro,
    useActionState: ro,
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
      return t.queue = e, t = Sc.bind(
        null,
        $,
        !0,
        e
      ), e.dispatch = t, [l, t];
    },
    useMemoCache: fc,
    useCacheRefresh: function() {
      return Vl().memoizedState = dh.bind(
        null,
        $
      );
    },
    useEffectEvent: function(l) {
      var t = Vl(), e = { impl: l };
      return t.memoizedState = e, function() {
        if ((nl & 2) !== 0)
          throw Error(o(440));
        return e.impl.apply(void 0, arguments);
      };
    }
  }, bc = {
    readContext: Bl,
    use: vn,
    useCallback: zo,
    useContext: Bl,
    useEffect: mc,
    useImperativeHandle: Ao,
    useInsertionEffect: bo,
    useLayoutEffect: po,
    useMemo: To,
    useReducer: yn,
    useRef: yo,
    useState: function() {
      return yn(Vt);
    },
    useDebugValue: hc,
    useDeferredValue: function(l, t) {
      var e = xl();
      return xo(
        e,
        ol.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = yn(Vt)[0], t = xl().memoizedState;
      return [
        typeof l == "boolean" ? l : cu(l),
        t
      ];
    },
    useSyncExternalStore: Ps,
    useId: _o,
    useHostTransitionStatus: gc,
    useFormState: mo,
    useActionState: mo,
    useOptimistic: function(l, t) {
      var e = xl();
      return no(e, ol, l, t);
    },
    useMemoCache: fc,
    useCacheRefresh: Mo
  };
  bc.useEffectEvent = So;
  var Ho = {
    readContext: Bl,
    use: vn,
    useCallback: zo,
    useContext: Bl,
    useEffect: mc,
    useImperativeHandle: Ao,
    useInsertionEffect: bo,
    useLayoutEffect: po,
    useMemo: To,
    useReducer: oc,
    useRef: yo,
    useState: function() {
      return oc(Vt);
    },
    useDebugValue: hc,
    useDeferredValue: function(l, t) {
      var e = xl();
      return ol === null ? vc(e, l, t) : xo(
        e,
        ol.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = oc(Vt)[0], t = xl().memoizedState;
      return [
        typeof l == "boolean" ? l : cu(l),
        t
      ];
    },
    useSyncExternalStore: Ps,
    useId: _o,
    useHostTransitionStatus: gc,
    useFormState: vo,
    useActionState: vo,
    useOptimistic: function(l, t) {
      var e = xl();
      return ol !== null ? no(e, ol, l, t) : (e.baseState = l, [l, e.queue.dispatch]);
    },
    useMemoCache: fc,
    useCacheRefresh: Mo
  };
  Ho.useEffectEvent = So;
  function pc(l, t, e, a) {
    t = l.memoizedState, e = e(a, t), e = e == null ? t : A({}, t, e), l.memoizedState = e, l.lanes === 0 && (l.updateQueue.baseState = e);
  }
  var jc = {
    enqueueSetState: function(l, t, e) {
      l = l._reactInternals;
      var a = rt(), u = se(a);
      u.payload = t, e != null && (u.callback = e), t = oe(l, u, a), t !== null && (lt(t, l, a), au(t, l, a));
    },
    enqueueReplaceState: function(l, t, e) {
      l = l._reactInternals;
      var a = rt(), u = se(a);
      u.tag = 1, u.payload = t, e != null && (u.callback = e), t = oe(l, u, a), t !== null && (lt(t, l, a), au(t, l, a));
    },
    enqueueForceUpdate: function(l, t) {
      l = l._reactInternals;
      var e = rt(), a = se(e);
      a.tag = 2, t != null && (a.callback = t), t = oe(l, a, e), t !== null && (lt(t, l, e), au(t, l, e));
    }
  };
  function qo(l, t, e, a, u, n, i) {
    return l = l.stateNode, typeof l.shouldComponentUpdate == "function" ? l.shouldComponentUpdate(a, n, i) : t.prototype && t.prototype.isPureReactComponent ? !Wa(e, a) || !Wa(u, n) : !0;
  }
  function Bo(l, t, e, a) {
    l = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(e, a), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(e, a), t.state !== l && jc.enqueueReplaceState(t, t.state, null);
  }
  function Ke(l, t) {
    var e = t;
    if ("ref" in t) {
      e = {};
      for (var a in t)
        a !== "ref" && (e[a] = t[a]);
    }
    if (l = l.defaultProps) {
      e === t && (e = A({}, e));
      for (var u in l)
        e[u] === void 0 && (e[u] = l[u]);
    }
    return e;
  }
  function Yo(l) {
    ku(l);
  }
  function Go(l) {
    console.error(l);
  }
  function Xo(l) {
    ku(l);
  }
  function pn(l, t) {
    try {
      var e = l.onUncaughtError;
      e(t.value, { componentStack: t.stack });
    } catch (a) {
      setTimeout(function() {
        throw a;
      });
    }
  }
  function Qo(l, t, e) {
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
      pn(l, t);
    }, e;
  }
  function Lo(l) {
    return l = se(l), l.tag = 3, l;
  }
  function Zo(l, t, e, a) {
    var u = e.type.getDerivedStateFromError;
    if (typeof u == "function") {
      var n = a.value;
      l.payload = function() {
        return u(n);
      }, l.callback = function() {
        Qo(t, e, a);
      };
    }
    var i = e.stateNode;
    i !== null && typeof i.componentDidCatch == "function" && (l.callback = function() {
      Qo(t, e, a), typeof u != "function" && (ye === null ? ye = /* @__PURE__ */ new Set([this]) : ye.add(this));
      var f = a.stack;
      this.componentDidCatch(a.value, {
        componentStack: f !== null ? f : ""
      });
    });
  }
  function mh(l, t, e, a, u) {
    if (e.flags |= 32768, a !== null && typeof a == "object" && typeof a.then == "function") {
      if (t = e.alternate, t !== null && ma(
        t,
        e,
        u,
        !0
      ), e = ft.current, e !== null) {
        switch (e.tag) {
          case 31:
          case 13:
            return pt === null ? Un() : e.alternate === null && pl === 0 && (pl = 3), e.flags &= -257, e.flags |= 65536, e.lanes = u, a === cn ? e.flags |= 16384 : (t = e.updateQueue, t === null ? e.updateQueue = /* @__PURE__ */ new Set([a]) : t.add(a), wc(l, a, u)), !1;
          case 22:
            return e.flags |= 65536, a === cn ? e.flags |= 16384 : (t = e.updateQueue, t === null ? (t = {
              transitions: null,
              markerInstances: null,
              retryQueue: /* @__PURE__ */ new Set([a])
            }, e.updateQueue = t) : (e = t.retryQueue, e === null ? t.retryQueue = /* @__PURE__ */ new Set([a]) : e.add(a)), wc(l, a, u)), !1;
        }
        throw Error(o(435, e.tag));
      }
      return wc(l, a, u), Un(), !1;
    }
    if (el)
      return t = ft.current, t !== null ? ((t.flags & 65536) === 0 && (t.flags |= 256), t.flags |= 65536, t.lanes = u, a !== Qi && (l = Error(o(422), { cause: a }), Ia(yt(l, e)))) : (a !== Qi && (t = Error(o(423), {
        cause: a
      }), Ia(
        yt(t, e)
      )), l = l.current.alternate, l.flags |= 65536, u &= -u, l.lanes |= u, a = yt(a, e), u = Ac(
        l.stateNode,
        a,
        u
      ), Ii(l, u), pl !== 4 && (pl = 2)), !1;
    var n = Error(o(520), { cause: a });
    if (n = yt(n, e), gu === null ? gu = [n] : gu.push(n), pl !== 4 && (pl = 2), t === null) return !0;
    a = yt(a, e), e = t;
    do {
      switch (e.tag) {
        case 3:
          return e.flags |= 65536, l = u & -u, e.lanes |= l, l = Ac(e.stateNode, a, l), Ii(e, l), !1;
        case 1:
          if (t = e.type, n = e.stateNode, (e.flags & 128) === 0 && (typeof t.getDerivedStateFromError == "function" || n !== null && typeof n.componentDidCatch == "function" && (ye === null || !ye.has(n))))
            return e.flags |= 65536, u &= -u, e.lanes |= u, u = Lo(u), Zo(
              u,
              l,
              e,
              a
            ), Ii(e, u), !1;
      }
      e = e.return;
    } while (e !== null);
    return !1;
  }
  var zc = Error(o(461)), _l = !1;
  function Yl(l, t, e, a) {
    t.child = l === null ? Js(t, null, e, a) : Ze(
      t,
      l.child,
      e,
      a
    );
  }
  function Vo(l, t, e, a, u) {
    e = e.render;
    var n = t.ref;
    if ("ref" in a) {
      var i = {};
      for (var f in a)
        f !== "ref" && (i[f] = a[f]);
    } else i = a;
    return Ge(t), a = uc(
      l,
      t,
      e,
      i,
      n,
      u
    ), f = nc(), l !== null && !_l ? (ic(l, t, u), Kt(l, t, u)) : (el && f && Gi(t), t.flags |= 1, Yl(l, t, a, u), t.child);
  }
  function Ko(l, t, e, a, u) {
    if (l === null) {
      var n = e.type;
      return typeof n == "function" && !qi(n) && n.defaultProps === void 0 && e.compare === null ? (t.tag = 15, t.type = n, Jo(
        l,
        t,
        n,
        a,
        u
      )) : (l = ln(
        e.type,
        null,
        a,
        t,
        t.mode,
        u
      ), l.ref = t.ref, l.return = t, t.child = l);
    }
    if (n = l.child, !Dc(l, u)) {
      var i = n.memoizedProps;
      if (e = e.compare, e = e !== null ? e : Wa, e(i, a) && l.ref === t.ref)
        return Kt(l, t, u);
    }
    return t.flags |= 1, l = Gt(n, a), l.ref = t.ref, l.return = t, t.child = l;
  }
  function Jo(l, t, e, a, u) {
    if (l !== null) {
      var n = l.memoizedProps;
      if (Wa(n, a) && l.ref === t.ref)
        if (_l = !1, t.pendingProps = a = n, Dc(l, u))
          (l.flags & 131072) !== 0 && (_l = !0);
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
  function wo(l, t, e, a) {
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
        return $o(
          l,
          t,
          n,
          e,
          a
        );
      }
      if ((e & 536870912) !== 0)
        t.memoizedState = { baseLanes: 0, cachePool: null }, l !== null && un(
          t,
          n !== null ? n.cachePool : null
        ), n !== null ? Ws(t, n) : lc(), ks(t);
      else
        return a = t.lanes = 536870912, $o(
          l,
          t,
          n !== null ? n.baseLanes | e : e,
          e,
          a
        );
    } else
      n !== null ? (un(t, n.cachePool), Ws(t, n), re(), t.memoizedState = null) : (l !== null && un(t, null), lc(), re());
    return Yl(l, t, u, e), t.child;
  }
  function ou(l, t) {
    return l !== null && l.tag === 22 || t.stateNode !== null || (t.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), t.sibling;
  }
  function $o(l, t, e, a, u) {
    var n = $i();
    return n = n === null ? null : { parent: Nl._currentValue, pool: n }, t.memoizedState = {
      baseLanes: e,
      cachePool: n
    }, l !== null && un(t, null), lc(), ks(t), l !== null && ma(l, t, a, !0), t.childLanes = u, null;
  }
  function jn(l, t) {
    return t = zn(
      { mode: t.mode, children: t.children },
      l.mode
    ), t.ref = l.ref, l.child = t, t.return = l, t;
  }
  function Wo(l, t, e) {
    return Ze(t, l.child, null, e), l = jn(t, t.pendingProps), l.flags |= 2, st(t), t.memoizedState = null, l;
  }
  function hh(l, t, e) {
    var a = t.pendingProps, u = (t.flags & 128) !== 0;
    if (t.flags &= -129, l === null) {
      if (el) {
        if (a.mode === "hidden")
          return l = jn(t, a), t.lanes = 536870912, ou(null, l);
        if (ec(t), (l = vl) ? (l = cr(
          l,
          bt
        ), l = l !== null && l.data === "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ue !== null ? { id: Dt, overflow: Ut } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, e = Ds(l), e.return = t, t.child = e, ql = t, vl = null)) : l = null, l === null) throw ie(t);
        return t.lanes = 536870912, null;
      }
      return jn(t, a);
    }
    var n = l.memoizedState;
    if (n !== null) {
      var i = n.dehydrated;
      if (ec(t), u)
        if (t.flags & 256)
          t.flags &= -257, t = Wo(
            l,
            t,
            e
          );
        else if (t.memoizedState !== null)
          t.child = l.child, t.flags |= 128, t = null;
        else throw Error(o(558));
      else if (_l || ma(l, t, e, !1), u = (e & l.childLanes) !== 0, _l || u) {
        if (a = hl, a !== null && (i = Yf(a, e), i !== 0 && i !== n.retryLane))
          throw n.retryLane = i, He(l, i), lt(a, l, i), zc;
        Un(), t = Wo(
          l,
          t,
          e
        );
      } else
        l = n.treeContext, vl = jt(i.nextSibling), ql = t, el = !0, ne = null, bt = !1, l !== null && Rs(t, l), t = jn(t, a), t.flags |= 4096;
      return t;
    }
    return l = Gt(l.child, {
      mode: a.mode,
      children: a.children
    }), l.ref = t.ref, t.child = l, l.return = t, l;
  }
  function An(l, t) {
    var e = t.ref;
    if (e === null)
      l !== null && l.ref !== null && (t.flags |= 4194816);
    else {
      if (typeof e != "function" && typeof e != "object")
        throw Error(o(284));
      (l === null || l.ref !== e) && (t.flags |= 4194816);
    }
  }
  function Tc(l, t, e, a, u) {
    return Ge(t), e = uc(
      l,
      t,
      e,
      a,
      void 0,
      u
    ), a = nc(), l !== null && !_l ? (ic(l, t, u), Kt(l, t, u)) : (el && a && Gi(t), t.flags |= 1, Yl(l, t, e, u), t.child);
  }
  function ko(l, t, e, a, u, n) {
    return Ge(t), t.updateQueue = null, e = Is(
      t,
      a,
      e,
      u
    ), Fs(l), a = nc(), l !== null && !_l ? (ic(l, t, n), Kt(l, t, n)) : (el && a && Gi(t), t.flags |= 1, Yl(l, t, e, n), t.child);
  }
  function Fo(l, t, e, a, u) {
    if (Ge(t), t.stateNode === null) {
      var n = sa, i = e.contextType;
      typeof i == "object" && i !== null && (n = Bl(i)), n = new e(a, n), t.memoizedState = n.state !== null && n.state !== void 0 ? n.state : null, n.updater = jc, t.stateNode = n, n._reactInternals = t, n = t.stateNode, n.props = a, n.state = t.memoizedState, n.refs = {}, ki(t), i = e.contextType, n.context = typeof i == "object" && i !== null ? Bl(i) : sa, n.state = t.memoizedState, i = e.getDerivedStateFromProps, typeof i == "function" && (pc(
        t,
        e,
        i,
        a
      ), n.state = t.memoizedState), typeof e.getDerivedStateFromProps == "function" || typeof n.getSnapshotBeforeUpdate == "function" || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (i = n.state, typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount(), i !== n.state && jc.enqueueReplaceState(n, n.state, null), nu(t, a, n, u), uu(), n.state = t.memoizedState), typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !0;
    } else if (l === null) {
      n = t.stateNode;
      var f = t.memoizedProps, s = Ke(e, f);
      n.props = s;
      var y = n.context, b = e.contextType;
      i = sa, typeof b == "object" && b !== null && (i = Bl(b));
      var T = e.getDerivedStateFromProps;
      b = typeof T == "function" || typeof n.getSnapshotBeforeUpdate == "function", f = t.pendingProps !== f, b || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (f || y !== i) && Bo(
        t,
        n,
        a,
        i
      ), fe = !1;
      var g = t.memoizedState;
      n.state = g, nu(t, a, n, u), uu(), y = t.memoizedState, f || g !== y || fe ? (typeof T == "function" && (pc(
        t,
        e,
        T,
        a
      ), y = t.memoizedState), (s = fe || qo(
        t,
        e,
        s,
        a,
        g,
        y,
        i
      )) ? (b || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount()), typeof n.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = a, t.memoizedState = y), n.props = a, n.state = y, n.context = i, a = s) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !1);
    } else {
      n = t.stateNode, Fi(l, t), i = t.memoizedProps, b = Ke(e, i), n.props = b, T = t.pendingProps, g = n.context, y = e.contextType, s = sa, typeof y == "object" && y !== null && (s = Bl(y)), f = e.getDerivedStateFromProps, (y = typeof f == "function" || typeof n.getSnapshotBeforeUpdate == "function") || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (i !== T || g !== s) && Bo(
        t,
        n,
        a,
        s
      ), fe = !1, g = t.memoizedState, n.state = g, nu(t, a, n, u), uu();
      var S = t.memoizedState;
      i !== T || g !== S || fe || l !== null && l.dependencies !== null && en(l.dependencies) ? (typeof f == "function" && (pc(
        t,
        e,
        f,
        a
      ), S = t.memoizedState), (b = fe || qo(
        t,
        e,
        b,
        a,
        g,
        S,
        s
      ) || l !== null && l.dependencies !== null && en(l.dependencies)) ? (y || typeof n.UNSAFE_componentWillUpdate != "function" && typeof n.componentWillUpdate != "function" || (typeof n.componentWillUpdate == "function" && n.componentWillUpdate(a, S, s), typeof n.UNSAFE_componentWillUpdate == "function" && n.UNSAFE_componentWillUpdate(
        a,
        S,
        s
      )), typeof n.componentDidUpdate == "function" && (t.flags |= 4), typeof n.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), t.memoizedProps = a, t.memoizedState = S), n.props = a, n.state = S, n.context = s, a = b) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), a = !1);
    }
    return n = a, An(l, t), a = (t.flags & 128) !== 0, n || a ? (n = t.stateNode, e = a && typeof e.getDerivedStateFromError != "function" ? null : n.render(), t.flags |= 1, l !== null && a ? (t.child = Ze(
      t,
      l.child,
      null,
      u
    ), t.child = Ze(
      t,
      null,
      e,
      u
    )) : Yl(l, t, e, u), t.memoizedState = n.state, l = t.child) : l = Kt(
      l,
      t,
      u
    ), l;
  }
  function Io(l, t, e, a) {
    return Be(), t.flags |= 256, Yl(l, t, e, a), t.child;
  }
  var xc = {
    dehydrated: null,
    treeContext: null,
    retryLane: 0,
    hydrationErrors: null
  };
  function Ec(l) {
    return { baseLanes: l, cachePool: Xs() };
  }
  function Nc(l, t, e) {
    return l = l !== null ? l.childLanes & ~e : 0, t && (l |= dt), l;
  }
  function Po(l, t, e) {
    var a = t.pendingProps, u = !1, n = (t.flags & 128) !== 0, i;
    if ((i = n) || (i = l !== null && l.memoizedState === null ? !1 : (Tl.current & 2) !== 0), i && (u = !0, t.flags &= -129), i = (t.flags & 32) !== 0, t.flags &= -33, l === null) {
      if (el) {
        if (u ? de(t) : re(), (l = vl) ? (l = cr(
          l,
          bt
        ), l = l !== null && l.data !== "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ue !== null ? { id: Dt, overflow: Ut } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, e = Ds(l), e.return = t, t.child = e, ql = t, vl = null)) : l = null, l === null) throw ie(t);
        return of(l) ? t.lanes = 32 : t.lanes = 536870912, null;
      }
      var f = a.children;
      return a = a.fallback, u ? (re(), u = t.mode, f = zn(
        { mode: "hidden", children: f },
        u
      ), a = qe(
        a,
        u,
        e,
        null
      ), f.return = t, a.return = t, f.sibling = a, t.child = f, a = t.child, a.memoizedState = Ec(e), a.childLanes = Nc(
        l,
        i,
        e
      ), t.memoizedState = xc, ou(null, a)) : (de(t), Oc(t, f));
    }
    var s = l.memoizedState;
    if (s !== null && (f = s.dehydrated, f !== null)) {
      if (n)
        t.flags & 256 ? (de(t), t.flags &= -257, t = _c(
          l,
          t,
          e
        )) : t.memoizedState !== null ? (re(), t.child = l.child, t.flags |= 128, t = null) : (re(), f = a.fallback, u = t.mode, a = zn(
          { mode: "visible", children: a.children },
          u
        ), f = qe(
          f,
          u,
          e,
          null
        ), f.flags |= 2, a.return = t, f.return = t, a.sibling = f, t.child = a, Ze(
          t,
          l.child,
          null,
          e
        ), a = t.child, a.memoizedState = Ec(e), a.childLanes = Nc(
          l,
          i,
          e
        ), t.memoizedState = xc, t = ou(null, a));
      else if (de(t), of(f)) {
        if (i = f.nextSibling && f.nextSibling.dataset, i) var y = i.dgst;
        i = y, a = Error(o(419)), a.stack = "", a.digest = i, Ia({ value: a, source: null, stack: null }), t = _c(
          l,
          t,
          e
        );
      } else if (_l || ma(l, t, e, !1), i = (e & l.childLanes) !== 0, _l || i) {
        if (i = hl, i !== null && (a = Yf(i, e), a !== 0 && a !== s.retryLane))
          throw s.retryLane = a, He(l, a), lt(i, l, a), zc;
        sf(f) || Un(), t = _c(
          l,
          t,
          e
        );
      } else
        sf(f) ? (t.flags |= 192, t.child = l.child, t = null) : (l = s.treeContext, vl = jt(
          f.nextSibling
        ), ql = t, el = !0, ne = null, bt = !1, l !== null && Rs(t, l), t = Oc(
          t,
          a.children
        ), t.flags |= 4096);
      return t;
    }
    return u ? (re(), f = a.fallback, u = t.mode, s = l.child, y = s.sibling, a = Gt(s, {
      mode: "hidden",
      children: a.children
    }), a.subtreeFlags = s.subtreeFlags & 65011712, y !== null ? f = Gt(
      y,
      f
    ) : (f = qe(
      f,
      u,
      e,
      null
    ), f.flags |= 2), f.return = t, a.return = t, a.sibling = f, t.child = a, ou(null, a), a = t.child, f = l.child.memoizedState, f === null ? f = Ec(e) : (u = f.cachePool, u !== null ? (s = Nl._currentValue, u = u.parent !== s ? { parent: s, pool: s } : u) : u = Xs(), f = {
      baseLanes: f.baseLanes | e,
      cachePool: u
    }), a.memoizedState = f, a.childLanes = Nc(
      l,
      i,
      e
    ), t.memoizedState = xc, ou(l.child, a)) : (de(t), e = l.child, l = e.sibling, e = Gt(e, {
      mode: "visible",
      children: a.children
    }), e.return = t, e.sibling = null, l !== null && (i = t.deletions, i === null ? (t.deletions = [l], t.flags |= 16) : i.push(l)), t.child = e, t.memoizedState = null, e);
  }
  function Oc(l, t) {
    return t = zn(
      { mode: "visible", children: t },
      l.mode
    ), t.return = l, l.child = t;
  }
  function zn(l, t) {
    return l = ct(22, l, null, t), l.lanes = 0, l;
  }
  function _c(l, t, e) {
    return Ze(t, l.child, null, e), l = Oc(
      t,
      t.pendingProps.children
    ), l.flags |= 2, t.memoizedState = null, l;
  }
  function ld(l, t, e) {
    l.lanes |= t;
    var a = l.alternate;
    a !== null && (a.lanes |= t), Vi(l.return, t, e);
  }
  function Mc(l, t, e, a, u, n) {
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
  function td(l, t, e) {
    var a = t.pendingProps, u = a.revealOrder, n = a.tail;
    a = a.children;
    var i = Tl.current, f = (i & 2) !== 0;
    if (f ? (i = i & 1 | 2, t.flags |= 128) : i &= 1, R(Tl, i), Yl(l, t, a, e), a = el ? Fa : 0, !f && l !== null && (l.flags & 128) !== 0)
      l: for (l = t.child; l !== null; ) {
        if (l.tag === 13)
          l.memoizedState !== null && ld(l, e, t);
        else if (l.tag === 19)
          ld(l, e, t);
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
          l = e.alternate, l !== null && dn(l) === null && (u = e), e = e.sibling;
        e = u, e === null ? (u = t.child, t.child = null) : (u = e.sibling, e.sibling = null), Mc(
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
          if (l = u.alternate, l !== null && dn(l) === null) {
            t.child = u;
            break;
          }
          l = u.sibling, u.sibling = e, e = u, u = l;
        }
        Mc(
          t,
          !0,
          e,
          null,
          n,
          a
        );
        break;
      case "together":
        Mc(
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
      throw Error(o(153));
    if (t.child !== null) {
      for (l = t.child, e = Gt(l, l.pendingProps), t.child = e, e.return = t; l.sibling !== null; )
        l = l.sibling, e = e.sibling = Gt(l, l.pendingProps), e.return = t;
      e.sibling = null;
    }
    return t.child;
  }
  function Dc(l, t) {
    return (l.lanes & t) !== 0 ? !0 : (l = l.dependencies, !!(l !== null && en(l)));
  }
  function vh(l, t, e) {
    switch (t.tag) {
      case 3:
        Zl(t, t.stateNode.containerInfo), ce(t, Nl, l.memoizedState.cache), Be();
        break;
      case 27:
      case 5:
        qa(t);
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
          return t.flags |= 128, ec(t), null;
        break;
      case 13:
        var a = t.memoizedState;
        if (a !== null)
          return a.dehydrated !== null ? (de(t), t.flags |= 128, null) : (e & t.child.childLanes) !== 0 ? Po(l, t, e) : (de(t), l = Kt(
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
            return td(
              l,
              t,
              e
            );
          t.flags |= 128;
        }
        if (u = t.memoizedState, u !== null && (u.rendering = null, u.tail = null, u.lastEffect = null), R(Tl, Tl.current), a) break;
        return null;
      case 22:
        return t.lanes = 0, wo(
          l,
          t,
          e,
          t.pendingProps
        );
      case 24:
        ce(t, Nl, l.memoizedState.cache);
    }
    return Kt(l, t, e);
  }
  function ed(l, t, e) {
    if (l !== null)
      if (l.memoizedProps !== t.pendingProps)
        _l = !0;
      else {
        if (!Dc(l, e) && (t.flags & 128) === 0)
          return _l = !1, vh(
            l,
            t,
            e
          );
        _l = (l.flags & 131072) !== 0;
      }
    else
      _l = !1, el && (t.flags & 1048576) !== 0 && Cs(t, Fa, t.index);
    switch (t.lanes = 0, t.tag) {
      case 16:
        l: {
          var a = t.pendingProps;
          if (l = Qe(t.elementType), t.type = l, typeof l == "function")
            qi(l) ? (a = Ke(l, a), t.tag = 1, t = Fo(
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
              if (u === Xl) {
                t.tag = 11, t = Vo(
                  null,
                  t,
                  l,
                  a,
                  e
                );
                break l;
              } else if (u === tl) {
                t.tag = 14, t = Ko(
                  null,
                  t,
                  l,
                  a,
                  e
                );
                break l;
              }
            }
            throw t = Ht(l) || l, Error(o(306, t, ""));
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
        return a = t.type, u = Ke(
          a,
          t.pendingProps
        ), Fo(
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
          ), l === null) throw Error(o(387));
          a = t.pendingProps;
          var n = t.memoizedState;
          u = n.element, Fi(l, t), nu(t, a, null, e);
          var i = t.memoizedState;
          if (a = i.cache, ce(t, Nl, a), a !== n.cache && Ki(
            t,
            [Nl],
            e,
            !0
          ), uu(), a = i.element, n.isDehydrated)
            if (n = {
              element: a,
              isDehydrated: !1,
              cache: i.cache
            }, t.updateQueue.baseState = n, t.memoizedState = n, t.flags & 256) {
              t = Io(
                l,
                t,
                a,
                e
              );
              break l;
            } else if (a !== u) {
              u = yt(
                Error(o(424)),
                t
              ), Ia(u), t = Io(
                l,
                t,
                a,
                e
              );
              break l;
            } else
              for (l = t.stateNode.containerInfo, l.nodeType === 9 ? l = l.body : l = l.nodeName === "HTML" ? l.ownerDocument.body : l, vl = jt(l.firstChild), ql = t, el = !0, ne = null, bt = !0, e = Js(
                t,
                null,
                a,
                e
              ), t.child = e; e; )
                e.flags = e.flags & -3 | 4096, e = e.sibling;
          else {
            if (Be(), a === u) {
              t = Kt(
                l,
                t,
                e
              );
              break l;
            }
            Yl(l, t, a, e);
          }
          t = t.child;
        }
        return t;
      case 26:
        return An(l, t), l === null ? (e = mr(
          t.type,
          null,
          t.pendingProps,
          null
        )) ? t.memoizedState = e : el || (e = t.type, l = t.pendingProps, a = Gn(
          k.current
        ).createElement(e), a[Hl] = t, a[$l] = l, Gl(a, e, l), Ul(a), t.stateNode = a) : t.memoizedState = mr(
          t.type,
          l.memoizedProps,
          t.pendingProps,
          l.memoizedState
        ), null;
      case 27:
        return qa(t), l === null && el && (a = t.stateNode = or(
          t.type,
          t.pendingProps,
          k.current
        ), ql = t, bt = !0, u = vl, pe(t.type) ? (df = u, vl = jt(a.firstChild)) : vl = u), Yl(
          l,
          t,
          t.pendingProps.children,
          e
        ), An(l, t), l === null && (t.flags |= 4194304), t.child;
      case 5:
        return l === null && el && ((u = a = vl) && (a = Kh(
          a,
          t.type,
          t.pendingProps,
          bt
        ), a !== null ? (t.stateNode = a, ql = t, vl = jt(a.firstChild), bt = !1, u = !0) : u = !1), u || ie(t)), qa(t), u = t.type, n = t.pendingProps, i = l !== null ? l.memoizedProps : null, a = n.children, nf(u, n) ? a = null : i !== null && nf(u, i) && (t.flags |= 32), t.memoizedState !== null && (u = uc(
          l,
          t,
          ih,
          null,
          null,
          e
        ), xu._currentValue = u), An(l, t), Yl(l, t, a, e), t.child;
      case 6:
        return l === null && el && ((l = e = vl) && (e = Jh(
          e,
          t.pendingProps,
          bt
        ), e !== null ? (t.stateNode = e, ql = t, vl = null, l = !0) : l = !1), l || ie(t)), null;
      case 13:
        return Po(l, t, e);
      case 4:
        return Zl(
          t,
          t.stateNode.containerInfo
        ), a = t.pendingProps, l === null ? t.child = Ze(
          t,
          null,
          a,
          e
        ) : Yl(l, t, a, e), t.child;
      case 11:
        return Vo(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 7:
        return Yl(
          l,
          t,
          t.pendingProps,
          e
        ), t.child;
      case 8:
        return Yl(
          l,
          t,
          t.pendingProps.children,
          e
        ), t.child;
      case 12:
        return Yl(
          l,
          t,
          t.pendingProps.children,
          e
        ), t.child;
      case 10:
        return a = t.pendingProps, ce(t, t.type, a.value), Yl(l, t, a.children, e), t.child;
      case 9:
        return u = t.type._context, a = t.pendingProps.children, Ge(t), u = Bl(u), a = a(u), t.flags |= 1, Yl(l, t, a, e), t.child;
      case 14:
        return Ko(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 15:
        return Jo(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 19:
        return td(l, t, e);
      case 31:
        return hh(l, t, e);
      case 22:
        return wo(
          l,
          t,
          e,
          t.pendingProps
        );
      case 24:
        return Ge(t), a = Bl(Nl), l === null ? (u = $i(), u === null && (u = hl, n = Ji(), u.pooledCache = n, n.refCount++, n !== null && (u.pooledCacheLanes |= e), u = n), t.memoizedState = { parent: a, cache: u }, ki(t), ce(t, Nl, u)) : ((l.lanes & e) !== 0 && (Fi(l, t), nu(t, null, null, e), uu()), u = l.memoizedState, n = t.memoizedState, u.parent !== a ? (u = { parent: a, cache: a }, t.memoizedState = u, t.lanes === 0 && (t.memoizedState = t.updateQueue.baseState = u), ce(t, Nl, a)) : (a = n.cache, ce(t, Nl, a), a !== u.cache && Ki(
          t,
          [Nl],
          e,
          !0
        ))), Yl(
          l,
          t,
          t.pendingProps.children,
          e
        ), t.child;
      case 29:
        throw t.pendingProps;
    }
    throw Error(o(156, t.tag));
  }
  function Jt(l) {
    l.flags |= 4;
  }
  function Uc(l, t, e, a, u) {
    if ((t = (l.mode & 32) !== 0) && (t = !1), t) {
      if (l.flags |= 16777216, (u & 335544128) === u)
        if (l.stateNode.complete) l.flags |= 8192;
        else if (_d()) l.flags |= 8192;
        else
          throw Le = cn, Wi;
    } else l.flags &= -16777217;
  }
  function ad(l, t) {
    if (t.type !== "stylesheet" || (t.state.loading & 4) !== 0)
      l.flags &= -16777217;
    else if (l.flags |= 16777216, !Sr(t))
      if (_d()) l.flags |= 8192;
      else
        throw Le = cn, Wi;
  }
  function Tn(l, t) {
    t !== null && (l.flags |= 4), l.flags & 16384 && (t = l.tag !== 22 ? Hf() : 536870912, l.lanes |= t, xa |= t);
  }
  function du(l, t) {
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
  function yl(l) {
    var t = l.alternate !== null && l.alternate.child === l.child, e = 0, a = 0;
    if (t)
      for (var u = l.child; u !== null; )
        e |= u.lanes | u.childLanes, a |= u.subtreeFlags & 65011712, a |= u.flags & 65011712, u.return = l, u = u.sibling;
    else
      for (u = l.child; u !== null; )
        e |= u.lanes | u.childLanes, a |= u.subtreeFlags, a |= u.flags, u.return = l, u = u.sibling;
    return l.subtreeFlags |= a, l.childLanes = e, t;
  }
  function yh(l, t, e) {
    var a = t.pendingProps;
    switch (Xi(t), t.tag) {
      case 16:
      case 15:
      case 0:
      case 11:
      case 7:
      case 8:
      case 12:
      case 9:
      case 14:
        return yl(t), null;
      case 1:
        return yl(t), null;
      case 3:
        return e = t.stateNode, a = null, l !== null && (a = l.memoizedState.cache), t.memoizedState.cache !== a && (t.flags |= 2048), Lt(Nl), zl(), e.pendingContext && (e.context = e.pendingContext, e.pendingContext = null), (l === null || l.child === null) && (ra(t) ? Jt(t) : l === null || l.memoizedState.isDehydrated && (t.flags & 256) === 0 || (t.flags |= 1024, Li())), yl(t), null;
      case 26:
        var u = t.type, n = t.memoizedState;
        return l === null ? (Jt(t), n !== null ? (yl(t), ad(t, n)) : (yl(t), Uc(
          t,
          u,
          null,
          a,
          e
        ))) : n ? n !== l.memoizedState ? (Jt(t), yl(t), ad(t, n)) : (yl(t), t.flags &= -16777217) : (l = l.memoizedProps, l !== a && Jt(t), yl(t), Uc(
          t,
          u,
          l,
          a,
          e
        )), null;
      case 27:
        if (Ru(t), e = k.current, u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Jt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(o(166));
            return yl(t), null;
          }
          l = B.current, ra(t) ? Hs(t) : (l = or(u, a, e), t.stateNode = l, Jt(t));
        }
        return yl(t), null;
      case 5:
        if (Ru(t), u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Jt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(o(166));
            return yl(t), null;
          }
          if (n = B.current, ra(t))
            Hs(t);
          else {
            var i = Gn(
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
            n[Hl] = t, n[$l] = a;
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
            l: switch (Gl(n, u, a), u) {
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
        return yl(t), Uc(
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
            throw Error(o(166));
          if (l = k.current, ra(t)) {
            if (l = t.stateNode, e = t.memoizedProps, a = null, u = ql, u !== null)
              switch (u.tag) {
                case 27:
                case 5:
                  a = u.memoizedProps;
              }
            l[Hl] = t, l = !!(l.nodeValue === e || a !== null && a.suppressHydrationWarning === !0 || Pd(l.nodeValue, e)), l || ie(t, !0);
          } else
            l = Gn(l).createTextNode(
              a
            ), l[Hl] = t, t.stateNode = l;
        }
        return yl(t), null;
      case 31:
        if (e = t.memoizedState, l === null || l.memoizedState !== null) {
          if (a = ra(t), e !== null) {
            if (l === null) {
              if (!a) throw Error(o(318));
              if (l = t.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(557));
              l[Hl] = t;
            } else
              Be(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            yl(t), l = !1;
          } else
            e = Li(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = e), l = !0;
          if (!l)
            return t.flags & 256 ? (st(t), t) : (st(t), null);
          if ((t.flags & 128) !== 0)
            throw Error(o(558));
        }
        return yl(t), null;
      case 13:
        if (a = t.memoizedState, l === null || l.memoizedState !== null && l.memoizedState.dehydrated !== null) {
          if (u = ra(t), a !== null && a.dehydrated !== null) {
            if (l === null) {
              if (!u) throw Error(o(318));
              if (u = t.memoizedState, u = u !== null ? u.dehydrated : null, !u) throw Error(o(317));
              u[Hl] = t;
            } else
              Be(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            yl(t), u = !1;
          } else
            u = Li(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = u), u = !0;
          if (!u)
            return t.flags & 256 ? (st(t), t) : (st(t), null);
        }
        return st(t), (t.flags & 128) !== 0 ? (t.lanes = e, t) : (e = a !== null, l = l !== null && l.memoizedState !== null, e && (a = t.child, u = null, a.alternate !== null && a.alternate.memoizedState !== null && a.alternate.memoizedState.cachePool !== null && (u = a.alternate.memoizedState.cachePool.pool), n = null, a.memoizedState !== null && a.memoizedState.cachePool !== null && (n = a.memoizedState.cachePool.pool), n !== u && (a.flags |= 2048)), e !== l && e && (t.child.flags |= 8192), Tn(t, t.updateQueue), yl(t), null);
      case 4:
        return zl(), l === null && lf(t.stateNode.containerInfo), yl(t), null;
      case 10:
        return Lt(t.type), yl(t), null;
      case 19:
        if (E(Tl), a = t.memoizedState, a === null) return yl(t), null;
        if (u = (t.flags & 128) !== 0, n = a.rendering, n === null)
          if (u) du(a, !1);
          else {
            if (pl !== 0 || l !== null && (l.flags & 128) !== 0)
              for (l = t.child; l !== null; ) {
                if (n = dn(l), n !== null) {
                  for (t.flags |= 128, du(a, !1), l = n.updateQueue, t.updateQueue = l, Tn(t, l), t.subtreeFlags = 0, l = e, e = t.child; e !== null; )
                    Ms(e, l), e = e.sibling;
                  return R(
                    Tl,
                    Tl.current & 1 | 2
                  ), el && Xt(t, a.treeForkCount), t.child;
                }
                l = l.sibling;
              }
            a.tail !== null && at() > _n && (t.flags |= 128, u = !0, du(a, !1), t.lanes = 4194304);
          }
        else {
          if (!u)
            if (l = dn(n), l !== null) {
              if (t.flags |= 128, u = !0, l = l.updateQueue, t.updateQueue = l, Tn(t, l), du(a, !0), a.tail === null && a.tailMode === "hidden" && !n.alternate && !el)
                return yl(t), null;
            } else
              2 * at() - a.renderingStartTime > _n && e !== 536870912 && (t.flags |= 128, u = !0, du(a, !1), t.lanes = 4194304);
          a.isBackwards ? (n.sibling = t.child, t.child = n) : (l = a.last, l !== null ? l.sibling = n : t.child = n, a.last = n);
        }
        return a.tail !== null ? (l = a.tail, a.rendering = l, a.tail = l.sibling, a.renderingStartTime = at(), l.sibling = null, e = Tl.current, R(
          Tl,
          u ? e & 1 | 2 : e & 1
        ), el && Xt(t, a.treeForkCount), l) : (yl(t), null);
      case 22:
      case 23:
        return st(t), tc(), a = t.memoizedState !== null, l !== null ? l.memoizedState !== null !== a && (t.flags |= 8192) : a && (t.flags |= 8192), a ? (e & 536870912) !== 0 && (t.flags & 128) === 0 && (yl(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : yl(t), e = t.updateQueue, e !== null && Tn(t, e.retryQueue), e = null, l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (e = l.memoizedState.cachePool.pool), a = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (a = t.memoizedState.cachePool.pool), a !== e && (t.flags |= 2048), l !== null && E(Xe), null;
      case 24:
        return e = null, l !== null && (e = l.memoizedState.cache), t.memoizedState.cache !== e && (t.flags |= 2048), Lt(Nl), yl(t), null;
      case 25:
        return null;
      case 30:
        return null;
    }
    throw Error(o(156, t.tag));
  }
  function gh(l, t) {
    switch (Xi(t), t.tag) {
      case 1:
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 3:
        return Lt(Nl), zl(), l = t.flags, (l & 65536) !== 0 && (l & 128) === 0 ? (t.flags = l & -65537 | 128, t) : null;
      case 26:
      case 27:
      case 5:
        return Ru(t), null;
      case 31:
        if (t.memoizedState !== null) {
          if (st(t), t.alternate === null)
            throw Error(o(340));
          Be();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 13:
        if (st(t), l = t.memoizedState, l !== null && l.dehydrated !== null) {
          if (t.alternate === null)
            throw Error(o(340));
          Be();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 19:
        return E(Tl), null;
      case 4:
        return zl(), null;
      case 10:
        return Lt(t.type), null;
      case 22:
      case 23:
        return st(t), tc(), l !== null && E(Xe), l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 24:
        return Lt(Nl), null;
      case 25:
        return null;
      default:
        return null;
    }
  }
  function ud(l, t) {
    switch (Xi(t), t.tag) {
      case 3:
        Lt(Nl), zl();
        break;
      case 26:
      case 27:
      case 5:
        Ru(t);
        break;
      case 4:
        zl();
        break;
      case 31:
        t.memoizedState !== null && st(t);
        break;
      case 13:
        st(t);
        break;
      case 19:
        E(Tl);
        break;
      case 10:
        Lt(t.type);
        break;
      case 22:
      case 23:
        st(t), tc(), l !== null && E(Xe);
        break;
      case 24:
        Lt(Nl);
    }
  }
  function ru(l, t) {
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
    } catch (f) {
      fl(t, t.return, f);
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
            var i = a.inst, f = i.destroy;
            if (f !== void 0) {
              i.destroy = void 0, u = t;
              var s = e, y = f;
              try {
                y();
              } catch (b) {
                fl(
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
      fl(t, t.return, b);
    }
  }
  function nd(l) {
    var t = l.updateQueue;
    if (t !== null) {
      var e = l.stateNode;
      try {
        $s(t, e);
      } catch (a) {
        fl(l, l.return, a);
      }
    }
  }
  function id(l, t, e) {
    e.props = Ke(
      l.type,
      l.memoizedProps
    ), e.state = l.memoizedState;
    try {
      e.componentWillUnmount();
    } catch (a) {
      fl(l, t, a);
    }
  }
  function mu(l, t) {
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
      fl(l, t, u);
    }
  }
  function Ct(l, t) {
    var e = l.ref, a = l.refCleanup;
    if (e !== null)
      if (typeof a == "function")
        try {
          a();
        } catch (u) {
          fl(l, t, u);
        } finally {
          l.refCleanup = null, l = l.alternate, l != null && (l.refCleanup = null);
        }
      else if (typeof e == "function")
        try {
          e(null);
        } catch (u) {
          fl(l, t, u);
        }
      else e.current = null;
  }
  function cd(l) {
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
      fl(l, l.return, u);
    }
  }
  function Cc(l, t, e) {
    try {
      var a = l.stateNode;
      Gh(a, l.type, e, t), a[$l] = t;
    } catch (u) {
      fl(l, l.return, u);
    }
  }
  function fd(l) {
    return l.tag === 5 || l.tag === 3 || l.tag === 26 || l.tag === 27 && pe(l.type) || l.tag === 4;
  }
  function Rc(l) {
    l: for (; ; ) {
      for (; l.sibling === null; ) {
        if (l.return === null || fd(l.return)) return null;
        l = l.return;
      }
      for (l.sibling.return = l.return, l = l.sibling; l.tag !== 5 && l.tag !== 6 && l.tag !== 18; ) {
        if (l.tag === 27 && pe(l.type) || l.flags & 2 || l.child === null || l.tag === 4) continue l;
        l.child.return = l, l = l.child;
      }
      if (!(l.flags & 2)) return l.stateNode;
    }
  }
  function Hc(l, t, e) {
    var a = l.tag;
    if (a === 5 || a === 6)
      l = l.stateNode, t ? (e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e).insertBefore(l, t) : (t = e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e, t.appendChild(l), e = e._reactRootContainer, e != null || t.onclick !== null || (t.onclick = Bt));
    else if (a !== 4 && (a === 27 && pe(l.type) && (e = l.stateNode, t = null), l = l.child, l !== null))
      for (Hc(l, t, e), l = l.sibling; l !== null; )
        Hc(l, t, e), l = l.sibling;
  }
  function xn(l, t, e) {
    var a = l.tag;
    if (a === 5 || a === 6)
      l = l.stateNode, t ? e.insertBefore(l, t) : e.appendChild(l);
    else if (a !== 4 && (a === 27 && pe(l.type) && (e = l.stateNode), l = l.child, l !== null))
      for (xn(l, t, e), l = l.sibling; l !== null; )
        xn(l, t, e), l = l.sibling;
  }
  function sd(l) {
    var t = l.stateNode, e = l.memoizedProps;
    try {
      for (var a = l.type, u = t.attributes; u.length; )
        t.removeAttributeNode(u[0]);
      Gl(t, a, e), t[Hl] = l, t[$l] = e;
    } catch (n) {
      fl(l, l.return, n);
    }
  }
  var wt = !1, Ml = !1, qc = !1, od = typeof WeakSet == "function" ? WeakSet : Set, Cl = null;
  function Sh(l, t) {
    if (l = l.containerInfo, af = Jn, l = js(l), _i(l)) {
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
            var i = 0, f = -1, s = -1, y = 0, b = 0, T = l, g = null;
            t: for (; ; ) {
              for (var S; T !== e || u !== 0 && T.nodeType !== 3 || (f = i + u), T !== n || a !== 0 && T.nodeType !== 3 || (s = i + a), T.nodeType === 3 && (i += T.nodeValue.length), (S = T.firstChild) !== null; )
                g = T, T = S;
              for (; ; ) {
                if (T === l) break t;
                if (g === e && ++y === u && (f = i), g === n && ++b === a && (s = i), (S = T.nextSibling) !== null) break;
                T = g, g = T.parentNode;
              }
              T = S;
            }
            e = f === -1 || s === -1 ? null : { start: f, end: s };
          } else e = null;
        }
      e = e || { start: 0, end: 0 };
    } else e = null;
    for (uf = { focusedElem: l, selectionRange: e }, Jn = !1, Cl = t; Cl !== null; )
      if (t = Cl, l = t.child, (t.subtreeFlags & 1028) !== 0 && l !== null)
        l.return = t, Cl = l;
      else
        for (; Cl !== null; ) {
          switch (t = Cl, n = t.alternate, l = t.flags, t.tag) {
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
                  var H = Ke(
                    e.type,
                    u
                  );
                  l = a.getSnapshotBeforeUpdate(
                    H,
                    n
                  ), a.__reactInternalSnapshotBeforeUpdate = l;
                } catch (Q) {
                  fl(
                    e,
                    e.return,
                    Q
                  );
                }
              }
              break;
            case 3:
              if ((l & 1024) !== 0) {
                if (l = t.stateNode.containerInfo, e = l.nodeType, e === 9)
                  ff(l);
                else if (e === 1)
                  switch (l.nodeName) {
                    case "HEAD":
                    case "HTML":
                    case "BODY":
                      ff(l);
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
              if ((l & 1024) !== 0) throw Error(o(163));
          }
          if (l = t.sibling, l !== null) {
            l.return = t.return, Cl = l;
            break;
          }
          Cl = t.return;
        }
  }
  function dd(l, t, e) {
    var a = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 15:
        Wt(l, e), a & 4 && ru(5, e);
        break;
      case 1:
        if (Wt(l, e), a & 4)
          if (l = e.stateNode, t === null)
            try {
              l.componentDidMount();
            } catch (i) {
              fl(e, e.return, i);
            }
          else {
            var u = Ke(
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
              fl(
                e,
                e.return,
                i
              );
            }
          }
        a & 64 && nd(e), a & 512 && mu(e, e.return);
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
            $s(l, t);
          } catch (i) {
            fl(e, e.return, i);
          }
        }
        break;
      case 27:
        t === null && a & 4 && sd(e);
      case 26:
      case 5:
        Wt(l, e), t === null && a & 4 && cd(e), a & 512 && mu(e, e.return);
        break;
      case 12:
        Wt(l, e);
        break;
      case 31:
        Wt(l, e), a & 4 && hd(l, e);
        break;
      case 13:
        Wt(l, e), a & 4 && vd(l, e), a & 64 && (l = e.memoizedState, l !== null && (l = l.dehydrated, l !== null && (e = Nh.bind(
          null,
          e
        ), wh(l, e))));
        break;
      case 22:
        if (a = e.memoizedState !== null || wt, !a) {
          t = t !== null && t.memoizedState !== null || Ml, u = wt;
          var n = Ml;
          wt = a, (Ml = t) && !n ? kt(
            l,
            e,
            (e.subtreeFlags & 8772) !== 0
          ) : Wt(l, e), wt = u, Ml = n;
        }
        break;
      case 30:
        break;
      default:
        Wt(l, e);
    }
  }
  function rd(l) {
    var t = l.alternate;
    t !== null && (l.alternate = null, rd(t)), l.child = null, l.deletions = null, l.sibling = null, l.tag === 5 && (t = l.stateNode, t !== null && ri(t)), l.stateNode = null, l.return = null, l.dependencies = null, l.memoizedProps = null, l.memoizedState = null, l.pendingProps = null, l.stateNode = null, l.updateQueue = null;
  }
  var Sl = null, kl = !1;
  function $t(l, t, e) {
    for (e = e.child; e !== null; )
      md(l, t, e), e = e.sibling;
  }
  function md(l, t, e) {
    if (ut && typeof ut.onCommitFiberUnmount == "function")
      try {
        ut.onCommitFiberUnmount(Ba, e);
      } catch {
      }
    switch (e.tag) {
      case 26:
        Ml || Ct(e, t), $t(
          l,
          t,
          e
        ), e.memoizedState ? e.memoizedState.count-- : e.stateNode && (e = e.stateNode, e.parentNode.removeChild(e));
        break;
      case 27:
        Ml || Ct(e, t);
        var a = Sl, u = kl;
        pe(e.type) && (Sl = e.stateNode, kl = !1), $t(
          l,
          t,
          e
        ), Au(e.stateNode), Sl = a, kl = u;
        break;
      case 5:
        Ml || Ct(e, t);
      case 6:
        if (a = Sl, u = kl, Sl = null, $t(
          l,
          t,
          e
        ), Sl = a, kl = u, Sl !== null)
          if (kl)
            try {
              (Sl.nodeType === 9 ? Sl.body : Sl.nodeName === "HTML" ? Sl.ownerDocument.body : Sl).removeChild(e.stateNode);
            } catch (n) {
              fl(
                e,
                t,
                n
              );
            }
          else
            try {
              Sl.removeChild(e.stateNode);
            } catch (n) {
              fl(
                e,
                t,
                n
              );
            }
        break;
      case 18:
        Sl !== null && (kl ? (l = Sl, nr(
          l.nodeType === 9 ? l.body : l.nodeName === "HTML" ? l.ownerDocument.body : l,
          e.stateNode
        ), Ca(l)) : nr(Sl, e.stateNode));
        break;
      case 4:
        a = Sl, u = kl, Sl = e.stateNode.containerInfo, kl = !0, $t(
          l,
          t,
          e
        ), Sl = a, kl = u;
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        me(2, e, t), Ml || me(4, e, t), $t(
          l,
          t,
          e
        );
        break;
      case 1:
        Ml || (Ct(e, t), a = e.stateNode, typeof a.componentWillUnmount == "function" && id(
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
        Ml = (a = Ml) || e.memoizedState !== null, $t(
          l,
          t,
          e
        ), Ml = a;
        break;
      default:
        $t(
          l,
          t,
          e
        );
    }
  }
  function hd(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null))) {
      l = l.dehydrated;
      try {
        Ca(l);
      } catch (e) {
        fl(t, t.return, e);
      }
    }
  }
  function vd(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null && (l = l.dehydrated, l !== null))))
      try {
        Ca(l);
      } catch (e) {
        fl(t, t.return, e);
      }
  }
  function bh(l) {
    switch (l.tag) {
      case 31:
      case 13:
      case 19:
        var t = l.stateNode;
        return t === null && (t = l.stateNode = new od()), t;
      case 22:
        return l = l.stateNode, t = l._retryCache, t === null && (t = l._retryCache = new od()), t;
      default:
        throw Error(o(435, l.tag));
    }
  }
  function En(l, t) {
    var e = bh(l);
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
        var u = e[a], n = l, i = t, f = i;
        l: for (; f !== null; ) {
          switch (f.tag) {
            case 27:
              if (pe(f.type)) {
                Sl = f.stateNode, kl = !1;
                break l;
              }
              break;
            case 5:
              Sl = f.stateNode, kl = !1;
              break l;
            case 3:
            case 4:
              Sl = f.stateNode.containerInfo, kl = !0;
              break l;
          }
          f = f.return;
        }
        if (Sl === null) throw Error(o(160));
        md(n, i, u), Sl = null, kl = !1, n = u.alternate, n !== null && (n.return = null), u.return = null;
      }
    if (t.subtreeFlags & 13886)
      for (t = t.child; t !== null; )
        yd(t, l), t = t.sibling;
  }
  var Et = null;
  function yd(l, t) {
    var e = l.alternate, a = l.flags;
    switch (l.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        Fl(t, l), Il(l), a & 4 && (me(3, l, l.return), ru(3, l), me(5, l, l.return));
        break;
      case 1:
        Fl(t, l), Il(l), a & 512 && (Ml || e === null || Ct(e, e.return)), a & 64 && wt && (l = l.updateQueue, l !== null && (a = l.callbacks, a !== null && (e = l.shared.hiddenCallbacks, l.shared.hiddenCallbacks = e === null ? a : e.concat(a))));
        break;
      case 26:
        var u = Et;
        if (Fl(t, l), Il(l), a & 512 && (Ml || e === null || Ct(e, e.return)), a & 4) {
          var n = e !== null ? e.memoizedState : null;
          if (a = l.memoizedState, e === null)
            if (a === null)
              if (l.stateNode === null) {
                l: {
                  a = l.type, e = l.memoizedProps, u = u.ownerDocument || u;
                  t: switch (a) {
                    case "title":
                      n = u.getElementsByTagName("title")[0], (!n || n[Xa] || n[Hl] || n.namespaceURI === "http://www.w3.org/2000/svg" || n.hasAttribute("itemprop")) && (n = u.createElement(a), u.head.insertBefore(
                        n,
                        u.querySelector("head > title")
                      )), Gl(n, a, e), n[Hl] = l, Ul(n), a = n;
                      break l;
                    case "link":
                      var i = yr(
                        "link",
                        "href",
                        u
                      ).get(a + (e.href || ""));
                      if (i) {
                        for (var f = 0; f < i.length; f++)
                          if (n = i[f], n.getAttribute("href") === (e.href == null || e.href === "" ? null : e.href) && n.getAttribute("rel") === (e.rel == null ? null : e.rel) && n.getAttribute("title") === (e.title == null ? null : e.title) && n.getAttribute("crossorigin") === (e.crossOrigin == null ? null : e.crossOrigin)) {
                            i.splice(f, 1);
                            break t;
                          }
                      }
                      n = u.createElement(a), Gl(n, a, e), u.head.appendChild(n);
                      break;
                    case "meta":
                      if (i = yr(
                        "meta",
                        "content",
                        u
                      ).get(a + (e.content || ""))) {
                        for (f = 0; f < i.length; f++)
                          if (n = i[f], n.getAttribute("content") === (e.content == null ? null : "" + e.content) && n.getAttribute("name") === (e.name == null ? null : e.name) && n.getAttribute("property") === (e.property == null ? null : e.property) && n.getAttribute("http-equiv") === (e.httpEquiv == null ? null : e.httpEquiv) && n.getAttribute("charset") === (e.charSet == null ? null : e.charSet)) {
                            i.splice(f, 1);
                            break t;
                          }
                      }
                      n = u.createElement(a), Gl(n, a, e), u.head.appendChild(n);
                      break;
                    default:
                      throw Error(o(468, a));
                  }
                  n[Hl] = l, Ul(n), a = n;
                }
                l.stateNode = a;
              } else
                gr(
                  u,
                  l.type,
                  l.stateNode
                );
            else
              l.stateNode = vr(
                u,
                a,
                l.memoizedProps
              );
          else
            n !== a ? (n === null ? e.stateNode !== null && (e = e.stateNode, e.parentNode.removeChild(e)) : n.count--, a === null ? gr(
              u,
              l.type,
              l.stateNode
            ) : vr(
              u,
              a,
              l.memoizedProps
            )) : a === null && l.stateNode !== null && Cc(
              l,
              l.memoizedProps,
              e.memoizedProps
            );
        }
        break;
      case 27:
        Fl(t, l), Il(l), a & 512 && (Ml || e === null || Ct(e, e.return)), e !== null && a & 4 && Cc(
          l,
          l.memoizedProps,
          e.memoizedProps
        );
        break;
      case 5:
        if (Fl(t, l), Il(l), a & 512 && (Ml || e === null || Ct(e, e.return)), l.flags & 32) {
          u = l.stateNode;
          try {
            ea(u, "");
          } catch (H) {
            fl(l, l.return, H);
          }
        }
        a & 4 && l.stateNode != null && (u = l.memoizedProps, Cc(
          l,
          u,
          e !== null ? e.memoizedProps : u
        )), a & 1024 && (qc = !0);
        break;
      case 6:
        if (Fl(t, l), Il(l), a & 4) {
          if (l.stateNode === null)
            throw Error(o(162));
          a = l.memoizedProps, e = l.stateNode;
          try {
            e.nodeValue = a;
          } catch (H) {
            fl(l, l.return, H);
          }
        }
        break;
      case 3:
        if (Ln = null, u = Et, Et = Xn(t.containerInfo), Fl(t, l), Et = u, Il(l), a & 4 && e !== null && e.memoizedState.isDehydrated)
          try {
            Ca(t.containerInfo);
          } catch (H) {
            fl(l, l.return, H);
          }
        qc && (qc = !1, gd(l));
        break;
      case 4:
        a = Et, Et = Xn(
          l.stateNode.containerInfo
        ), Fl(t, l), Il(l), Et = a;
        break;
      case 12:
        Fl(t, l), Il(l);
        break;
      case 31:
        Fl(t, l), Il(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, En(l, a)));
        break;
      case 13:
        Fl(t, l), Il(l), l.child.flags & 8192 && l.memoizedState !== null != (e !== null && e.memoizedState !== null) && (On = at()), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, En(l, a)));
        break;
      case 22:
        u = l.memoizedState !== null;
        var s = e !== null && e.memoizedState !== null, y = wt, b = Ml;
        if (wt = y || u, Ml = b || s, Fl(t, l), Ml = b, wt = y, Il(l), a & 8192)
          l: for (t = l.stateNode, t._visibility = u ? t._visibility & -2 : t._visibility | 1, u && (e === null || s || wt || Ml || Je(l)), e = null, t = l; ; ) {
            if (t.tag === 5 || t.tag === 26) {
              if (e === null) {
                s = e = t;
                try {
                  if (n = s.stateNode, u)
                    i = n.style, typeof i.setProperty == "function" ? i.setProperty("display", "none", "important") : i.display = "none";
                  else {
                    f = s.stateNode;
                    var T = s.memoizedProps.style, g = T != null && T.hasOwnProperty("display") ? T.display : null;
                    f.style.display = g == null || typeof g == "boolean" ? "" : ("" + g).trim();
                  }
                } catch (H) {
                  fl(s, s.return, H);
                }
              }
            } else if (t.tag === 6) {
              if (e === null) {
                s = t;
                try {
                  s.stateNode.nodeValue = u ? "" : s.memoizedProps;
                } catch (H) {
                  fl(s, s.return, H);
                }
              }
            } else if (t.tag === 18) {
              if (e === null) {
                s = t;
                try {
                  var S = s.stateNode;
                  u ? ir(S, !0) : ir(s.stateNode, !1);
                } catch (H) {
                  fl(s, s.return, H);
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
        a & 4 && (a = l.updateQueue, a !== null && (e = a.retryQueue, e !== null && (a.retryQueue = null, En(l, e))));
        break;
      case 19:
        Fl(t, l), Il(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, En(l, a)));
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
          if (fd(a)) {
            e = a;
            break;
          }
          a = a.return;
        }
        if (e == null) throw Error(o(160));
        switch (e.tag) {
          case 27:
            var u = e.stateNode, n = Rc(l);
            xn(l, n, u);
            break;
          case 5:
            var i = e.stateNode;
            e.flags & 32 && (ea(i, ""), e.flags &= -33);
            var f = Rc(l);
            xn(l, f, i);
            break;
          case 3:
          case 4:
            var s = e.stateNode.containerInfo, y = Rc(l);
            Hc(
              l,
              y,
              s
            );
            break;
          default:
            throw Error(o(161));
        }
      } catch (b) {
        fl(l, l.return, b);
      }
      l.flags &= -3;
    }
    t & 4096 && (l.flags &= -4097);
  }
  function gd(l) {
    if (l.subtreeFlags & 1024)
      for (l = l.child; l !== null; ) {
        var t = l;
        gd(t), t.tag === 5 && t.flags & 1024 && t.stateNode.reset(), l = l.sibling;
      }
  }
  function Wt(l, t) {
    if (t.subtreeFlags & 8772)
      for (t = t.child; t !== null; )
        dd(l, t.alternate, t), t = t.sibling;
  }
  function Je(l) {
    for (l = l.child; l !== null; ) {
      var t = l;
      switch (t.tag) {
        case 0:
        case 11:
        case 14:
        case 15:
          me(4, t, t.return), Je(t);
          break;
        case 1:
          Ct(t, t.return);
          var e = t.stateNode;
          typeof e.componentWillUnmount == "function" && id(
            t,
            t.return,
            e
          ), Je(t);
          break;
        case 27:
          Au(t.stateNode);
        case 26:
        case 5:
          Ct(t, t.return), Je(t);
          break;
        case 22:
          t.memoizedState === null && Je(t);
          break;
        case 30:
          Je(t);
          break;
        default:
          Je(t);
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
          ), ru(4, n);
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
              fl(a, a.return, y);
            }
          if (a = n, u = a.updateQueue, u !== null) {
            var f = a.stateNode;
            try {
              var s = u.shared.hiddenCallbacks;
              if (s !== null)
                for (u.shared.hiddenCallbacks = null, u = 0; u < s.length; u++)
                  ws(s[u], f);
            } catch (y) {
              fl(a, a.return, y);
            }
          }
          e && i & 64 && nd(n), mu(n, n.return);
          break;
        case 27:
          sd(n);
        case 26:
        case 5:
          kt(
            u,
            n,
            e
          ), e && a === null && i & 4 && cd(n), mu(n, n.return);
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
          ), e && i & 4 && hd(u, n);
          break;
        case 13:
          kt(
            u,
            n,
            e
          ), e && i & 4 && vd(u, n);
          break;
        case 22:
          n.memoizedState === null && kt(
            u,
            n,
            e
          ), mu(n, n.return);
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
  function Bc(l, t) {
    var e = null;
    l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (e = l.memoizedState.cachePool.pool), l = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (l = t.memoizedState.cachePool.pool), l !== e && (l != null && l.refCount++, e != null && Pa(e));
  }
  function Yc(l, t) {
    l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Pa(l));
  }
  function Nt(l, t, e, a) {
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; )
        Sd(
          l,
          t,
          e,
          a
        ), t = t.sibling;
  }
  function Sd(l, t, e, a) {
    var u = t.flags;
    switch (t.tag) {
      case 0:
      case 11:
      case 15:
        Nt(
          l,
          t,
          e,
          a
        ), u & 2048 && ru(9, t);
        break;
      case 1:
        Nt(
          l,
          t,
          e,
          a
        );
        break;
      case 3:
        Nt(
          l,
          t,
          e,
          a
        ), u & 2048 && (l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Pa(l)));
        break;
      case 12:
        if (u & 2048) {
          Nt(
            l,
            t,
            e,
            a
          ), l = t.stateNode;
          try {
            var n = t.memoizedProps, i = n.id, f = n.onPostCommit;
            typeof f == "function" && f(
              i,
              t.alternate === null ? "mount" : "update",
              l.passiveEffectDuration,
              -0
            );
          } catch (s) {
            fl(t, t.return, s);
          }
        } else
          Nt(
            l,
            t,
            e,
            a
          );
        break;
      case 31:
        Nt(
          l,
          t,
          e,
          a
        );
        break;
      case 13:
        Nt(
          l,
          t,
          e,
          a
        );
        break;
      case 23:
        break;
      case 22:
        n = t.stateNode, i = t.alternate, t.memoizedState !== null ? n._visibility & 2 ? Nt(
          l,
          t,
          e,
          a
        ) : hu(l, t) : n._visibility & 2 ? Nt(
          l,
          t,
          e,
          a
        ) : (n._visibility |= 2, Aa(
          l,
          t,
          e,
          a,
          (t.subtreeFlags & 10256) !== 0 || !1
        )), u & 2048 && Bc(i, t);
        break;
      case 24:
        Nt(
          l,
          t,
          e,
          a
        ), u & 2048 && Yc(t.alternate, t);
        break;
      default:
        Nt(
          l,
          t,
          e,
          a
        );
    }
  }
  function Aa(l, t, e, a, u) {
    for (u = u && ((t.subtreeFlags & 10256) !== 0 || !1), t = t.child; t !== null; ) {
      var n = l, i = t, f = e, s = a, y = i.flags;
      switch (i.tag) {
        case 0:
        case 11:
        case 15:
          Aa(
            n,
            i,
            f,
            s,
            u
          ), ru(8, i);
          break;
        case 23:
          break;
        case 22:
          var b = i.stateNode;
          i.memoizedState !== null ? b._visibility & 2 ? Aa(
            n,
            i,
            f,
            s,
            u
          ) : hu(
            n,
            i
          ) : (b._visibility |= 2, Aa(
            n,
            i,
            f,
            s,
            u
          )), u && y & 2048 && Bc(
            i.alternate,
            i
          );
          break;
        case 24:
          Aa(
            n,
            i,
            f,
            s,
            u
          ), u && y & 2048 && Yc(i.alternate, i);
          break;
        default:
          Aa(
            n,
            i,
            f,
            s,
            u
          );
      }
      t = t.sibling;
    }
  }
  function hu(l, t) {
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; ) {
        var e = l, a = t, u = a.flags;
        switch (a.tag) {
          case 22:
            hu(e, a), u & 2048 && Bc(
              a.alternate,
              a
            );
            break;
          case 24:
            hu(e, a), u & 2048 && Yc(a.alternate, a);
            break;
          default:
            hu(e, a);
        }
        t = t.sibling;
      }
  }
  var vu = 8192;
  function za(l, t, e) {
    if (l.subtreeFlags & vu)
      for (l = l.child; l !== null; )
        bd(
          l,
          t,
          e
        ), l = l.sibling;
  }
  function bd(l, t, e) {
    switch (l.tag) {
      case 26:
        za(
          l,
          t,
          e
        ), l.flags & vu && l.memoizedState !== null && nv(
          e,
          Et,
          l.memoizedState,
          l.memoizedProps
        );
        break;
      case 5:
        za(
          l,
          t,
          e
        );
        break;
      case 3:
      case 4:
        var a = Et;
        Et = Xn(l.stateNode.containerInfo), za(
          l,
          t,
          e
        ), Et = a;
        break;
      case 22:
        l.memoizedState === null && (a = l.alternate, a !== null && a.memoizedState !== null ? (a = vu, vu = 16777216, za(
          l,
          t,
          e
        ), vu = a) : za(
          l,
          t,
          e
        ));
        break;
      default:
        za(
          l,
          t,
          e
        );
    }
  }
  function pd(l) {
    var t = l.alternate;
    if (t !== null && (l = t.child, l !== null)) {
      t.child = null;
      do
        t = l.sibling, l.sibling = null, l = t;
      while (l !== null);
    }
  }
  function yu(l) {
    var t = l.deletions;
    if ((l.flags & 16) !== 0) {
      if (t !== null)
        for (var e = 0; e < t.length; e++) {
          var a = t[e];
          Cl = a, Ad(
            a,
            l
          );
        }
      pd(l);
    }
    if (l.subtreeFlags & 10256)
      for (l = l.child; l !== null; )
        jd(l), l = l.sibling;
  }
  function jd(l) {
    switch (l.tag) {
      case 0:
      case 11:
      case 15:
        yu(l), l.flags & 2048 && me(9, l, l.return);
        break;
      case 3:
        yu(l);
        break;
      case 12:
        yu(l);
        break;
      case 22:
        var t = l.stateNode;
        l.memoizedState !== null && t._visibility & 2 && (l.return === null || l.return.tag !== 13) ? (t._visibility &= -3, Nn(l)) : yu(l);
        break;
      default:
        yu(l);
    }
  }
  function Nn(l) {
    var t = l.deletions;
    if ((l.flags & 16) !== 0) {
      if (t !== null)
        for (var e = 0; e < t.length; e++) {
          var a = t[e];
          Cl = a, Ad(
            a,
            l
          );
        }
      pd(l);
    }
    for (l = l.child; l !== null; ) {
      switch (t = l, t.tag) {
        case 0:
        case 11:
        case 15:
          me(8, t, t.return), Nn(t);
          break;
        case 22:
          e = t.stateNode, e._visibility & 2 && (e._visibility &= -3, Nn(t));
          break;
        default:
          Nn(t);
      }
      l = l.sibling;
    }
  }
  function Ad(l, t) {
    for (; Cl !== null; ) {
      var e = Cl;
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
          Pa(e.memoizedState.cache);
      }
      if (a = e.child, a !== null) a.return = e, Cl = a;
      else
        l: for (e = l; Cl !== null; ) {
          a = Cl;
          var u = a.sibling, n = a.return;
          if (rd(a), a === e) {
            Cl = null;
            break l;
          }
          if (u !== null) {
            u.return = n, Cl = u;
            break l;
          }
          Cl = n;
        }
    }
  }
  var ph = {
    getCacheForType: function(l) {
      var t = Bl(Nl), e = t.data.get(l);
      return e === void 0 && (e = l(), t.data.set(l, e)), e;
    },
    cacheSignal: function() {
      return Bl(Nl).controller.signal;
    }
  }, jh = typeof WeakMap == "function" ? WeakMap : Map, nl = 0, hl = null, F = null, P = 0, cl = 0, ot = null, he = !1, Ta = !1, Gc = !1, Ft = 0, pl = 0, ve = 0, we = 0, Xc = 0, dt = 0, xa = 0, gu = null, Pl = null, Qc = !1, On = 0, zd = 0, _n = 1 / 0, Mn = null, ye = null, Dl = 0, ge = null, Ea = null, It = 0, Lc = 0, Zc = null, Td = null, Su = 0, Vc = null;
  function rt() {
    return (nl & 2) !== 0 && P !== 0 ? P & -P : j.T !== null ? kc() : Gf();
  }
  function xd() {
    if (dt === 0)
      if ((P & 536870912) === 0 || el) {
        var l = Bu;
        Bu <<= 1, (Bu & 3932160) === 0 && (Bu = 262144), dt = l;
      } else dt = 536870912;
    return l = ft.current, l !== null && (l.flags |= 32), dt;
  }
  function lt(l, t, e) {
    (l === hl && (cl === 2 || cl === 9) || l.cancelPendingCommit !== null) && (Na(l, 0), Se(
      l,
      P,
      dt,
      !1
    )), Ga(l, e), ((nl & 2) === 0 || l !== hl) && (l === hl && ((nl & 2) === 0 && (we |= e), pl === 4 && Se(
      l,
      P,
      dt,
      !1
    )), Rt(l));
  }
  function Ed(l, t, e) {
    if ((nl & 6) !== 0) throw Error(o(327));
    var a = !e && (t & 127) === 0 && (t & l.expiredLanes) === 0 || Ya(l, t), u = a ? Th(l, t) : Jc(l, t, !0), n = a;
    do {
      if (u === 0) {
        Ta && !a && Se(l, t, 0, !1);
        break;
      } else {
        if (e = l.current.alternate, n && !Ah(e)) {
          u = Jc(l, t, !1), n = !1;
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
              var f = l;
              u = gu;
              var s = f.current.memoizedState.isDehydrated;
              if (s && (Na(f, i).flags |= 256), i = Jc(
                f,
                i,
                !1
              ), i !== 2) {
                if (Gc && !s) {
                  f.errorRecoveryDisabledLanes |= n, we |= n, u = 4;
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
          Na(l, 0), Se(l, t, 0, !0);
          break;
        }
        l: {
          switch (a = l, n = u, n) {
            case 0:
            case 1:
              throw Error(o(345));
            case 4:
              if ((t & 4194048) !== t) break;
            case 6:
              Se(
                a,
                t,
                dt,
                !he
              );
              break l;
            case 2:
              Pl = null;
              break;
            case 3:
            case 5:
              break;
            default:
              throw Error(o(329));
          }
          if ((t & 62914560) === t && (u = On + 300 - at(), 10 < u)) {
            if (Se(
              a,
              t,
              dt,
              !he
            ), Gu(a, 0, !0) !== 0) break l;
            It = t, a.timeoutHandle = ar(
              Nd.bind(
                null,
                a,
                e,
                Pl,
                Mn,
                Qc,
                t,
                dt,
                we,
                xa,
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
          Nd(
            a,
            e,
            Pl,
            Mn,
            Qc,
            t,
            dt,
            we,
            xa,
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
    Rt(l);
  }
  function Nd(l, t, e, a, u, n, i, f, s, y, b, T, g, S) {
    if (l.timeoutHandle = -1, T = t.subtreeFlags, T & 8192 || (T & 16785408) === 16785408) {
      T = {
        stylesheets: null,
        count: 0,
        imgCount: 0,
        imgBytes: 0,
        suspenseyImages: [],
        waitingForImages: !0,
        waitingForViewTransition: !1,
        unsuspend: Bt
      }, bd(
        t,
        n,
        T
      );
      var H = (n & 62914560) === n ? On - at() : (n & 4194048) === n ? zd - at() : 0;
      if (H = iv(
        T,
        H
      ), H !== null) {
        It = n, l.cancelPendingCommit = H(
          Hd.bind(
            null,
            l,
            t,
            n,
            e,
            a,
            u,
            i,
            f,
            s,
            b,
            T,
            null,
            g,
            S
          )
        ), Se(l, n, i, !y);
        return;
      }
    }
    Hd(
      l,
      t,
      n,
      e,
      a,
      u,
      i,
      f,
      s
    );
  }
  function Ah(l) {
    for (var t = l; ; ) {
      var e = t.tag;
      if ((e === 0 || e === 11 || e === 15) && t.flags & 16384 && (e = t.updateQueue, e !== null && (e = e.stores, e !== null)))
        for (var a = 0; a < e.length; a++) {
          var u = e[a], n = u.getSnapshot;
          u = u.value;
          try {
            if (!it(n(), u)) return !1;
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
    t &= ~Xc, t &= ~we, l.suspendedLanes |= t, l.pingedLanes &= ~t, a && (l.warmLanes |= t), a = l.expirationTimes;
    for (var u = t; 0 < u; ) {
      var n = 31 - nt(u), i = 1 << n;
      a[n] = -1, u &= ~i;
    }
    e !== 0 && qf(l, e, t);
  }
  function Dn() {
    return (nl & 6) === 0 ? (bu(0), !1) : !0;
  }
  function Kc() {
    if (F !== null) {
      if (cl === 0)
        var l = F.return;
      else
        l = F, Qt = Ye = null, cc(l), ga = null, tu = 0, l = F;
      for (; l !== null; )
        ud(l.alternate, l), l = l.return;
      F = null;
    }
  }
  function Na(l, t) {
    var e = l.timeoutHandle;
    e !== -1 && (l.timeoutHandle = -1, Lh(e)), e = l.cancelPendingCommit, e !== null && (l.cancelPendingCommit = null, e()), It = 0, Kc(), hl = l, F = e = Gt(l.current, null), P = t, cl = 0, ot = null, he = !1, Ta = Ya(l, t), Gc = !1, xa = dt = Xc = we = ve = pl = 0, Pl = gu = null, Qc = !1, (t & 8) !== 0 && (t |= t & 32);
    var a = l.entangledLanes;
    if (a !== 0)
      for (l = l.entanglements, a &= t; 0 < a; ) {
        var u = 31 - nt(a), n = 1 << u;
        t |= l[u], a &= ~n;
      }
    return Ft = t, Fu(), e;
  }
  function Od(l, t) {
    $ = null, j.H = su, t === ya || t === nn ? (t = Zs(), cl = 3) : t === Wi ? (t = Zs(), cl = 4) : cl = t === zc ? 8 : t !== null && typeof t == "object" && typeof t.then == "function" ? 6 : 1, ot = t, F === null && (pl = 1, pn(
      l,
      yt(t, l.current)
    ));
  }
  function _d() {
    var l = ft.current;
    return l === null ? !0 : (P & 4194048) === P ? pt === null : (P & 62914560) === P || (P & 536870912) !== 0 ? l === pt : !1;
  }
  function Md() {
    var l = j.H;
    return j.H = su, l === null ? su : l;
  }
  function Dd() {
    var l = j.A;
    return j.A = ph, l;
  }
  function Un() {
    pl = 4, he || (P & 4194048) !== P && ft.current !== null || (Ta = !0), (ve & 134217727) === 0 && (we & 134217727) === 0 || hl === null || Se(
      hl,
      P,
      dt,
      !1
    );
  }
  function Jc(l, t, e) {
    var a = nl;
    nl |= 2;
    var u = Md(), n = Dd();
    (hl !== l || P !== t) && (Mn = null, Na(l, t)), t = !1;
    var i = pl;
    l: do
      try {
        if (cl !== 0 && F !== null) {
          var f = F, s = ot;
          switch (cl) {
            case 8:
              Kc(), i = 6;
              break l;
            case 3:
            case 2:
            case 9:
            case 6:
              ft.current === null && (t = !0);
              var y = cl;
              if (cl = 0, ot = null, Oa(l, f, s, y), e && Ta) {
                i = 0;
                break l;
              }
              break;
            default:
              y = cl, cl = 0, ot = null, Oa(l, f, s, y);
          }
        }
        zh(), i = pl;
        break;
      } catch (b) {
        Od(l, b);
      }
    while (!0);
    return t && l.shellSuspendCounter++, Qt = Ye = null, nl = a, j.H = u, j.A = n, F === null && (hl = null, P = 0, Fu()), i;
  }
  function zh() {
    for (; F !== null; ) Ud(F);
  }
  function Th(l, t) {
    var e = nl;
    nl |= 2;
    var a = Md(), u = Dd();
    hl !== l || P !== t ? (Mn = null, _n = at() + 500, Na(l, t)) : Ta = Ya(
      l,
      t
    );
    l: do
      try {
        if (cl !== 0 && F !== null) {
          t = F;
          var n = ot;
          t: switch (cl) {
            case 1:
              cl = 0, ot = null, Oa(l, t, n, 1);
              break;
            case 2:
            case 9:
              if (Qs(n)) {
                cl = 0, ot = null, Cd(t);
                break;
              }
              t = function() {
                cl !== 2 && cl !== 9 || hl !== l || (cl = 7), Rt(l);
              }, n.then(t, t);
              break l;
            case 3:
              cl = 7;
              break l;
            case 4:
              cl = 5;
              break l;
            case 7:
              Qs(n) ? (cl = 0, ot = null, Cd(t)) : (cl = 0, ot = null, Oa(l, t, n, 7));
              break;
            case 5:
              var i = null;
              switch (F.tag) {
                case 26:
                  i = F.memoizedState;
                case 5:
                case 27:
                  var f = F;
                  if (i ? Sr(i) : f.stateNode.complete) {
                    cl = 0, ot = null;
                    var s = f.sibling;
                    if (s !== null) F = s;
                    else {
                      var y = f.return;
                      y !== null ? (F = y, Cn(y)) : F = null;
                    }
                    break t;
                  }
              }
              cl = 0, ot = null, Oa(l, t, n, 5);
              break;
            case 6:
              cl = 0, ot = null, Oa(l, t, n, 6);
              break;
            case 8:
              Kc(), pl = 6;
              break l;
            default:
              throw Error(o(462));
          }
        }
        xh();
        break;
      } catch (b) {
        Od(l, b);
      }
    while (!0);
    return Qt = Ye = null, j.H = a, j.A = u, nl = e, F !== null ? 0 : (hl = null, P = 0, Fu(), pl);
  }
  function xh() {
    for (; F !== null && !$r(); )
      Ud(F);
  }
  function Ud(l) {
    var t = ed(l.alternate, l, Ft);
    l.memoizedProps = l.pendingProps, t === null ? Cn(l) : F = t;
  }
  function Cd(l) {
    var t = l, e = t.alternate;
    switch (t.tag) {
      case 15:
      case 0:
        t = ko(
          e,
          t,
          t.pendingProps,
          t.type,
          void 0,
          P
        );
        break;
      case 11:
        t = ko(
          e,
          t,
          t.pendingProps,
          t.type.render,
          t.ref,
          P
        );
        break;
      case 5:
        cc(t);
      default:
        ud(e, t), t = F = Ms(t, Ft), t = ed(e, t, Ft);
    }
    l.memoizedProps = l.pendingProps, t === null ? Cn(l) : F = t;
  }
  function Oa(l, t, e, a) {
    Qt = Ye = null, cc(t), ga = null, tu = 0;
    var u = t.return;
    try {
      if (mh(
        l,
        u,
        t,
        e,
        P
      )) {
        pl = 1, pn(
          l,
          yt(e, l.current)
        ), F = null;
        return;
      }
    } catch (n) {
      if (u !== null) throw F = u, n;
      pl = 1, pn(
        l,
        yt(e, l.current)
      ), F = null;
      return;
    }
    t.flags & 32768 ? (el || a === 1 ? l = !0 : Ta || (P & 536870912) !== 0 ? l = !1 : (he = l = !0, (a === 2 || a === 9 || a === 3 || a === 6) && (a = ft.current, a !== null && a.tag === 13 && (a.flags |= 16384))), Rd(t, l)) : Cn(t);
  }
  function Cn(l) {
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
      var e = yh(
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
    pl === 0 && (pl = 5);
  }
  function Rd(l, t) {
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
    pl = 6, F = null;
  }
  function Hd(l, t, e, a, u, n, i, f, s) {
    l.cancelPendingCommit = null;
    do
      Rn();
    while (Dl !== 0);
    if ((nl & 6) !== 0) throw Error(o(327));
    if (t !== null) {
      if (t === l.current) throw Error(o(177));
      if (n = t.lanes | t.childLanes, n |= Ri, um(
        l,
        e,
        n,
        i,
        f,
        s
      ), l === hl && (F = hl = null, P = 0), Ea = t, ge = l, It = e, Lc = n, Zc = u, Td = a, (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? (l.callbackNode = null, l.callbackPriority = 0, _h(Hu, function() {
        return Xd(), null;
      })) : (l.callbackNode = null, l.callbackPriority = 0), a = (t.flags & 13878) !== 0, (t.subtreeFlags & 13878) !== 0 || a) {
        a = j.T, j.T = null, u = U.p, U.p = 2, i = nl, nl |= 4;
        try {
          Sh(l, t, e);
        } finally {
          nl = i, U.p = u, j.T = a;
        }
      }
      Dl = 1, qd(), Bd(), Yd();
    }
  }
  function qd() {
    if (Dl === 1) {
      Dl = 0;
      var l = ge, t = Ea, e = (t.flags & 13878) !== 0;
      if ((t.subtreeFlags & 13878) !== 0 || e) {
        e = j.T, j.T = null;
        var a = U.p;
        U.p = 2;
        var u = nl;
        nl |= 4;
        try {
          yd(t, l);
          var n = uf, i = js(l.containerInfo), f = n.focusedElem, s = n.selectionRange;
          if (i !== f && f && f.ownerDocument && ps(
            f.ownerDocument.documentElement,
            f
          )) {
            if (s !== null && _i(f)) {
              var y = s.start, b = s.end;
              if (b === void 0 && (b = y), "selectionStart" in f)
                f.selectionStart = y, f.selectionEnd = Math.min(
                  b,
                  f.value.length
                );
              else {
                var T = f.ownerDocument || document, g = T && T.defaultView || window;
                if (g.getSelection) {
                  var S = g.getSelection(), H = f.textContent.length, Q = Math.min(s.start, H), rl = s.end === void 0 ? Q : Math.min(s.end, H);
                  !S.extend && Q > rl && (i = rl, rl = Q, Q = i);
                  var h = bs(
                    f,
                    Q
                  ), d = bs(
                    f,
                    rl
                  );
                  if (h && d && (S.rangeCount !== 1 || S.anchorNode !== h.node || S.anchorOffset !== h.offset || S.focusNode !== d.node || S.focusOffset !== d.offset)) {
                    var v = T.createRange();
                    v.setStart(h.node, h.offset), S.removeAllRanges(), Q > rl ? (S.addRange(v), S.extend(d.node, d.offset)) : (v.setEnd(d.node, d.offset), S.addRange(v));
                  }
                }
              }
            }
            for (T = [], S = f; S = S.parentNode; )
              S.nodeType === 1 && T.push({
                element: S,
                left: S.scrollLeft,
                top: S.scrollTop
              });
            for (typeof f.focus == "function" && f.focus(), f = 0; f < T.length; f++) {
              var z = T[f];
              z.element.scrollLeft = z.left, z.element.scrollTop = z.top;
            }
          }
          Jn = !!af, uf = af = null;
        } finally {
          nl = u, U.p = a, j.T = e;
        }
      }
      l.current = t, Dl = 2;
    }
  }
  function Bd() {
    if (Dl === 2) {
      Dl = 0;
      var l = ge, t = Ea, e = (t.flags & 8772) !== 0;
      if ((t.subtreeFlags & 8772) !== 0 || e) {
        e = j.T, j.T = null;
        var a = U.p;
        U.p = 2;
        var u = nl;
        nl |= 4;
        try {
          dd(l, t.alternate, t);
        } finally {
          nl = u, U.p = a, j.T = e;
        }
      }
      Dl = 3;
    }
  }
  function Yd() {
    if (Dl === 4 || Dl === 3) {
      Dl = 0, Wr();
      var l = ge, t = Ea, e = It, a = Td;
      (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? Dl = 5 : (Dl = 0, Ea = ge = null, Gd(l, l.pendingLanes));
      var u = l.pendingLanes;
      if (u === 0 && (ye = null), oi(e), t = t.stateNode, ut && typeof ut.onCommitFiberRoot == "function")
        try {
          ut.onCommitFiberRoot(
            Ba,
            t,
            void 0,
            (t.current.flags & 128) === 128
          );
        } catch {
        }
      if (a !== null) {
        t = j.T, u = U.p, U.p = 2, j.T = null;
        try {
          for (var n = l.onRecoverableError, i = 0; i < a.length; i++) {
            var f = a[i];
            n(f.value, {
              componentStack: f.stack
            });
          }
        } finally {
          j.T = t, U.p = u;
        }
      }
      (It & 3) !== 0 && Rn(), Rt(l), u = l.pendingLanes, (e & 261930) !== 0 && (u & 42) !== 0 ? l === Vc ? Su++ : (Su = 0, Vc = l) : Su = 0, bu(0);
    }
  }
  function Gd(l, t) {
    (l.pooledCacheLanes &= t) === 0 && (t = l.pooledCache, t != null && (l.pooledCache = null, Pa(t)));
  }
  function Rn() {
    return qd(), Bd(), Yd(), Xd();
  }
  function Xd() {
    if (Dl !== 5) return !1;
    var l = ge, t = Lc;
    Lc = 0;
    var e = oi(It), a = j.T, u = U.p;
    try {
      U.p = 32 > e ? 32 : e, j.T = null, e = Zc, Zc = null;
      var n = ge, i = It;
      if (Dl = 0, Ea = ge = null, It = 0, (nl & 6) !== 0) throw Error(o(331));
      var f = nl;
      if (nl |= 4, jd(n.current), Sd(
        n,
        n.current,
        i,
        e
      ), nl = f, bu(0, !1), ut && typeof ut.onPostCommitFiberRoot == "function")
        try {
          ut.onPostCommitFiberRoot(Ba, n);
        } catch {
        }
      return !0;
    } finally {
      U.p = u, j.T = a, Gd(l, t);
    }
  }
  function Qd(l, t, e) {
    t = yt(e, t), t = Ac(l.stateNode, t, 2), l = oe(l, t, 2), l !== null && (Ga(l, 2), Rt(l));
  }
  function fl(l, t, e) {
    if (l.tag === 3)
      Qd(l, l, e);
    else
      for (; t !== null; ) {
        if (t.tag === 3) {
          Qd(
            t,
            l,
            e
          );
          break;
        } else if (t.tag === 1) {
          var a = t.stateNode;
          if (typeof t.type.getDerivedStateFromError == "function" || typeof a.componentDidCatch == "function" && (ye === null || !ye.has(a))) {
            l = yt(e, l), e = Lo(2), a = oe(t, e, 2), a !== null && (Zo(
              e,
              a,
              t,
              l
            ), Ga(a, 2), Rt(a));
            break;
          }
        }
        t = t.return;
      }
  }
  function wc(l, t, e) {
    var a = l.pingCache;
    if (a === null) {
      a = l.pingCache = new jh();
      var u = /* @__PURE__ */ new Set();
      a.set(t, u);
    } else
      u = a.get(t), u === void 0 && (u = /* @__PURE__ */ new Set(), a.set(t, u));
    u.has(e) || (Gc = !0, u.add(e), l = Eh.bind(null, l, t, e), t.then(l, l));
  }
  function Eh(l, t, e) {
    var a = l.pingCache;
    a !== null && a.delete(t), l.pingedLanes |= l.suspendedLanes & e, l.warmLanes &= ~e, hl === l && (P & e) === e && (pl === 4 || pl === 3 && (P & 62914560) === P && 300 > at() - On ? (nl & 2) === 0 && Na(l, 0) : Xc |= e, xa === P && (xa = 0)), Rt(l);
  }
  function Ld(l, t) {
    t === 0 && (t = Hf()), l = He(l, t), l !== null && (Ga(l, t), Rt(l));
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
        throw Error(o(314));
    }
    a !== null && a.delete(t), Ld(l, e);
  }
  function _h(l, t) {
    return ii(l, t);
  }
  var Hn = null, _a = null, $c = !1, qn = !1, Wc = !1, be = 0;
  function Rt(l) {
    l !== _a && l.next === null && (_a === null ? Hn = _a = l : _a = _a.next = l), qn = !0, $c || ($c = !0, Dh());
  }
  function bu(l, t) {
    if (!Wc && qn) {
      Wc = !0;
      do
        for (var e = !1, a = Hn; a !== null; ) {
          if (l !== 0) {
            var u = a.pendingLanes;
            if (u === 0) var n = 0;
            else {
              var i = a.suspendedLanes, f = a.pingedLanes;
              n = (1 << 31 - nt(42 | l) + 1) - 1, n &= u & ~(i & ~f), n = n & 201326741 ? n & 201326741 | 1 : n ? n | 2 : 0;
            }
            n !== 0 && (e = !0, Jd(a, n));
          } else
            n = P, n = Gu(
              a,
              a === hl ? n : 0,
              a.cancelPendingCommit !== null || a.timeoutHandle !== -1
            ), (n & 3) === 0 || Ya(a, n) || (e = !0, Jd(a, n));
          a = a.next;
        }
      while (e);
      Wc = !1;
    }
  }
  function Mh() {
    Zd();
  }
  function Zd() {
    qn = $c = !1;
    var l = 0;
    be !== 0 && Qh() && (l = be);
    for (var t = at(), e = null, a = Hn; a !== null; ) {
      var u = a.next, n = Vd(a, t);
      n === 0 ? (a.next = null, e === null ? Hn = u : e.next = u, u === null && (_a = e)) : (e = a, (l !== 0 || (n & 3) !== 0) && (qn = !0)), a = u;
    }
    Dl !== 0 && Dl !== 5 || bu(l), be !== 0 && (be = 0);
  }
  function Vd(l, t) {
    for (var e = l.suspendedLanes, a = l.pingedLanes, u = l.expirationTimes, n = l.pendingLanes & -62914561; 0 < n; ) {
      var i = 31 - nt(n), f = 1 << i, s = u[i];
      s === -1 ? ((f & e) === 0 || (f & a) !== 0) && (u[i] = am(f, t)) : s <= t && (l.expiredLanes |= f), n &= ~f;
    }
    if (t = hl, e = P, e = Gu(
      l,
      l === t ? e : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), a = l.callbackNode, e === 0 || l === t && (cl === 2 || cl === 9) || l.cancelPendingCommit !== null)
      return a !== null && a !== null && ci(a), l.callbackNode = null, l.callbackPriority = 0;
    if ((e & 3) === 0 || Ya(l, e)) {
      if (t = e & -e, t === l.callbackPriority) return t;
      switch (a !== null && ci(a), oi(e)) {
        case 2:
        case 8:
          e = Cf;
          break;
        case 32:
          e = Hu;
          break;
        case 268435456:
          e = Rf;
          break;
        default:
          e = Hu;
      }
      return a = Kd.bind(null, l), e = ii(e, a), l.callbackPriority = t, l.callbackNode = e, t;
    }
    return a !== null && a !== null && ci(a), l.callbackPriority = 2, l.callbackNode = null, 2;
  }
  function Kd(l, t) {
    if (Dl !== 0 && Dl !== 5)
      return l.callbackNode = null, l.callbackPriority = 0, null;
    var e = l.callbackNode;
    if (Rn() && l.callbackNode !== e)
      return null;
    var a = P;
    return a = Gu(
      l,
      l === hl ? a : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), a === 0 ? null : (Ed(l, a, t), Vd(l, at()), l.callbackNode != null && l.callbackNode === e ? Kd.bind(null, l) : null);
  }
  function Jd(l, t) {
    if (Rn()) return null;
    Ed(l, t, !0);
  }
  function Dh() {
    Zh(function() {
      (nl & 6) !== 0 ? ii(
        Uf,
        Mh
      ) : Zd();
    });
  }
  function kc() {
    if (be === 0) {
      var l = ha;
      l === 0 && (l = qu, qu <<= 1, (qu & 261888) === 0 && (qu = 256)), be = l;
    }
    return be;
  }
  function wd(l) {
    return l == null || typeof l == "symbol" || typeof l == "boolean" ? null : typeof l == "function" ? l : Zu("" + l);
  }
  function $d(l, t) {
    var e = t.ownerDocument.createElement("input");
    return e.name = t.name, e.value = t.value, l.id && e.setAttribute("form", l.id), t.parentNode.insertBefore(e, t), l = new FormData(l), e.parentNode.removeChild(e), l;
  }
  function Uh(l, t, e, a, u) {
    if (t === "submit" && e && e.stateNode === u) {
      var n = wd(
        (u[$l] || null).action
      ), i = a.submitter;
      i && (t = (t = i[$l] || null) ? wd(t.formAction) : i.getAttribute("formAction"), t !== null && (n = t, i = null));
      var f = new wu(
        "action",
        "action",
        null,
        a,
        u
      );
      l.push({
        event: f,
        listeners: [
          {
            instance: null,
            listener: function() {
              if (a.defaultPrevented) {
                if (be !== 0) {
                  var s = i ? $d(u, i) : new FormData(u);
                  yc(
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
                typeof n == "function" && (f.preventDefault(), s = i ? $d(u, i) : new FormData(u), yc(
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
  for (var Fc = 0; Fc < Ci.length; Fc++) {
    var Ic = Ci[Fc], Ch = Ic.toLowerCase(), Rh = Ic[0].toUpperCase() + Ic.slice(1);
    xt(
      Ch,
      "on" + Rh
    );
  }
  xt(Ts, "onAnimationEnd"), xt(xs, "onAnimationIteration"), xt(Es, "onAnimationStart"), xt("dblclick", "onDoubleClick"), xt("focusin", "onFocus"), xt("focusout", "onBlur"), xt(km, "onTransitionRun"), xt(Fm, "onTransitionStart"), xt(Im, "onTransitionCancel"), xt(Ns, "onTransitionEnd"), la("onMouseEnter", ["mouseout", "mouseover"]), la("onMouseLeave", ["mouseout", "mouseover"]), la("onPointerEnter", ["pointerout", "pointerover"]), la("onPointerLeave", ["pointerout", "pointerover"]), De(
    "onChange",
    "change click focusin focusout input keydown keyup selectionchange".split(" ")
  ), De(
    "onSelect",
    "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(
      " "
    )
  ), De("onBeforeInput", [
    "compositionend",
    "keypress",
    "textInput",
    "paste"
  ]), De(
    "onCompositionEnd",
    "compositionend focusout keydown keypress keyup mousedown".split(" ")
  ), De(
    "onCompositionStart",
    "compositionstart focusout keydown keypress keyup mousedown".split(" ")
  ), De(
    "onCompositionUpdate",
    "compositionupdate focusout keydown keypress keyup mousedown".split(" ")
  );
  var pu = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
    " "
  ), Hh = new Set(
    "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(pu)
  );
  function Wd(l, t) {
    t = (t & 4) !== 0;
    for (var e = 0; e < l.length; e++) {
      var a = l[e], u = a.event;
      a = a.listeners;
      l: {
        var n = void 0;
        if (t)
          for (var i = a.length - 1; 0 <= i; i--) {
            var f = a[i], s = f.instance, y = f.currentTarget;
            if (f = f.listener, s !== n && u.isPropagationStopped())
              break l;
            n = f, u.currentTarget = y;
            try {
              n(u);
            } catch (b) {
              ku(b);
            }
            u.currentTarget = null, n = s;
          }
        else
          for (i = 0; i < a.length; i++) {
            if (f = a[i], s = f.instance, y = f.currentTarget, f = f.listener, s !== n && u.isPropagationStopped())
              break l;
            n = f, u.currentTarget = y;
            try {
              n(u);
            } catch (b) {
              ku(b);
            }
            u.currentTarget = null, n = s;
          }
      }
    }
  }
  function I(l, t) {
    var e = t[di];
    e === void 0 && (e = t[di] = /* @__PURE__ */ new Set());
    var a = l + "__bubble";
    e.has(a) || (kd(t, l, 2, !1), e.add(a));
  }
  function Pc(l, t, e) {
    var a = 0;
    t && (a |= 4), kd(
      e,
      l,
      a,
      t
    );
  }
  var Bn = "_reactListening" + Math.random().toString(36).slice(2);
  function lf(l) {
    if (!l[Bn]) {
      l[Bn] = !0, Lf.forEach(function(e) {
        e !== "selectionchange" && (Hh.has(e) || Pc(e, !1, l), Pc(e, !0, l));
      });
      var t = l.nodeType === 9 ? l : l.ownerDocument;
      t === null || t[Bn] || (t[Bn] = !0, Pc("selectionchange", !1, t));
    }
  }
  function kd(l, t, e, a) {
    switch (xr(t)) {
      case 2:
        var u = sv;
        break;
      case 8:
        u = ov;
        break;
      default:
        u = yf;
    }
    e = u.bind(
      null,
      t,
      e,
      l
    ), u = void 0, !pi || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (u = !0), a ? u !== void 0 ? l.addEventListener(t, e, {
      capture: !0,
      passive: u
    }) : l.addEventListener(t, e, !0) : u !== void 0 ? l.addEventListener(t, e, {
      passive: u
    }) : l.addEventListener(t, e, !1);
  }
  function tf(l, t, e, a, u) {
    var n = a;
    if ((t & 1) === 0 && (t & 2) === 0 && a !== null)
      l: for (; ; ) {
        if (a === null) return;
        var i = a.tag;
        if (i === 3 || i === 4) {
          var f = a.stateNode.containerInfo;
          if (f === u) break;
          if (i === 4)
            for (i = a.return; i !== null; ) {
              var s = i.tag;
              if ((s === 3 || s === 4) && i.stateNode.containerInfo === u)
                return;
              i = i.return;
            }
          for (; f !== null; ) {
            if (i = Fe(f), i === null) return;
            if (s = i.tag, s === 5 || s === 6 || s === 26 || s === 27) {
              a = n = i;
              continue l;
            }
            f = f.parentNode;
          }
        }
        a = a.return;
      }
    ls(function() {
      var y = n, b = Si(e), T = [];
      l: {
        var g = Os.get(l);
        if (g !== void 0) {
          var S = wu, H = l;
          switch (l) {
            case "keypress":
              if (Ku(e) === 0) break l;
            case "keydown":
            case "keyup":
              S = Om;
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
              S = as;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              S = ym;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              S = Dm;
              break;
            case Ts:
            case xs:
            case Es:
              S = bm;
              break;
            case Ns:
              S = Cm;
              break;
            case "scroll":
            case "scrollend":
              S = hm;
              break;
            case "wheel":
              S = Hm;
              break;
            case "copy":
            case "cut":
            case "paste":
              S = jm;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              S = ns;
              break;
            case "toggle":
            case "beforetoggle":
              S = Bm;
          }
          var Q = (t & 4) !== 0, rl = !Q && (l === "scroll" || l === "scrollend"), h = Q ? g !== null ? g + "Capture" : null : g;
          Q = [];
          for (var d = y, v; d !== null; ) {
            var z = d;
            if (v = z.stateNode, z = z.tag, z !== 5 && z !== 26 && z !== 27 || v === null || h === null || (z = La(d, h), z != null && Q.push(
              ju(d, z, v)
            )), rl) break;
            d = d.return;
          }
          0 < Q.length && (g = new S(
            g,
            H,
            null,
            e,
            b
          ), T.push({ event: g, listeners: Q }));
        }
      }
      if ((t & 7) === 0) {
        l: {
          if (g = l === "mouseover" || l === "pointerover", S = l === "mouseout" || l === "pointerout", g && e !== gi && (H = e.relatedTarget || e.fromElement) && (Fe(H) || H[ke]))
            break l;
          if ((S || g) && (g = b.window === b ? b : (g = b.ownerDocument) ? g.defaultView || g.parentWindow : window, S ? (H = e.relatedTarget || e.toElement, S = y, H = H ? Fe(H) : null, H !== null && (rl = D(H), Q = H.tag, H !== rl || Q !== 5 && Q !== 27 && Q !== 6) && (H = null)) : (S = null, H = y), S !== H)) {
            if (Q = as, z = "onMouseLeave", h = "onMouseEnter", d = "mouse", (l === "pointerout" || l === "pointerover") && (Q = ns, z = "onPointerLeave", h = "onPointerEnter", d = "pointer"), rl = S == null ? g : Qa(S), v = H == null ? g : Qa(H), g = new Q(
              z,
              d + "leave",
              S,
              e,
              b
            ), g.target = rl, g.relatedTarget = v, z = null, Fe(b) === y && (Q = new Q(
              h,
              d + "enter",
              H,
              e,
              b
            ), Q.target = v, Q.relatedTarget = rl, z = Q), rl = z, S && H)
              t: {
                for (Q = qh, h = S, d = H, v = 0, z = h; z; z = Q(z))
                  v++;
                z = 0;
                for (var X = d; X; X = Q(X))
                  z++;
                for (; 0 < v - z; )
                  h = Q(h), v--;
                for (; 0 < z - v; )
                  d = Q(d), z--;
                for (; v--; ) {
                  if (h === d || d !== null && h === d.alternate) {
                    Q = h;
                    break t;
                  }
                  h = Q(h), d = Q(d);
                }
                Q = null;
              }
            else Q = null;
            S !== null && Fd(
              T,
              g,
              S,
              Q,
              !1
            ), H !== null && rl !== null && Fd(
              T,
              rl,
              H,
              Q,
              !0
            );
          }
        }
        l: {
          if (g = y ? Qa(y) : window, S = g.nodeName && g.nodeName.toLowerCase(), S === "select" || S === "input" && g.type === "file")
            var al = ms;
          else if (ds(g))
            if (hs)
              al = wm;
            else {
              al = Km;
              var Y = Vm;
            }
          else
            S = g.nodeName, !S || S.toLowerCase() !== "input" || g.type !== "checkbox" && g.type !== "radio" ? y && yi(y.elementType) && (al = ms) : al = Jm;
          if (al && (al = al(l, y))) {
            rs(
              T,
              al,
              e,
              b
            );
            break l;
          }
          Y && Y(l, g, y), l === "focusout" && y && g.type === "number" && y.memoizedProps.value != null && vi(g, "number", g.value);
        }
        switch (Y = y ? Qa(y) : window, l) {
          case "focusin":
            (ds(Y) || Y.contentEditable === "true") && (ia = Y, Mi = y, ka = null);
            break;
          case "focusout":
            ka = Mi = ia = null;
            break;
          case "mousedown":
            Di = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            Di = !1, As(T, e, b);
            break;
          case "selectionchange":
            if (Wm) break;
          case "keydown":
          case "keyup":
            As(T, e, b);
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
          na ? ss(l, e) && (ll = "onCompositionEnd") : l === "keydown" && e.keyCode === 229 && (ll = "onCompositionStart");
        ll && (is && e.locale !== "ko" && (na || ll !== "onCompositionStart" ? ll === "onCompositionEnd" && na && (W = ts()) : (ae = b, ji = "value" in ae ? ae.value : ae.textContent, na = !0)), Y = Yn(y, ll), 0 < Y.length && (ll = new us(
          ll,
          l,
          null,
          e,
          b
        ), T.push({ event: ll, listeners: Y }), W ? ll.data = W : (W = os(e), W !== null && (ll.data = W)))), (W = Gm ? Xm(l, e) : Qm(l, e)) && (ll = Yn(y, "onBeforeInput"), 0 < ll.length && (Y = new us(
          "onBeforeInput",
          "beforeinput",
          null,
          e,
          b
        ), T.push({
          event: Y,
          listeners: ll
        }), Y.data = W)), Uh(
          T,
          l,
          y,
          e,
          b
        );
      }
      Wd(T, t);
    });
  }
  function ju(l, t, e) {
    return {
      instance: l,
      listener: t,
      currentTarget: e
    };
  }
  function Yn(l, t) {
    for (var e = t + "Capture", a = []; l !== null; ) {
      var u = l, n = u.stateNode;
      if (u = u.tag, u !== 5 && u !== 26 && u !== 27 || n === null || (u = La(l, e), u != null && a.unshift(
        ju(l, u, n)
      ), u = La(l, t), u != null && a.push(
        ju(l, u, n)
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
  function Fd(l, t, e, a, u) {
    for (var n = t._reactName, i = []; e !== null && e !== a; ) {
      var f = e, s = f.alternate, y = f.stateNode;
      if (f = f.tag, s !== null && s === a) break;
      f !== 5 && f !== 26 && f !== 27 || y === null || (s = y, u ? (y = La(e, n), y != null && i.unshift(
        ju(e, y, s)
      )) : u || (y = La(e, n), y != null && i.push(
        ju(e, y, s)
      ))), e = e.return;
    }
    i.length !== 0 && l.push({ event: t, listeners: i });
  }
  var Bh = /\r\n?/g, Yh = /\u0000|\uFFFD/g;
  function Id(l) {
    return (typeof l == "string" ? l : "" + l).replace(Bh, `
`).replace(Yh, "");
  }
  function Pd(l, t) {
    return t = Id(t), Id(l) === t;
  }
  function dl(l, t, e, a, u, n) {
    switch (e) {
      case "children":
        typeof a == "string" ? t === "body" || t === "textarea" && a === "" || ea(l, a) : (typeof a == "number" || typeof a == "bigint") && t !== "body" && ea(l, "" + a);
        break;
      case "className":
        Qu(l, "class", a);
        break;
      case "tabIndex":
        Qu(l, "tabindex", a);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        Qu(l, e, a);
        break;
      case "style":
        If(l, a, n);
        break;
      case "data":
        if (t !== "object") {
          Qu(l, "data", a);
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
        a = Zu("" + a), l.setAttribute(e, a);
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
          typeof n == "function" && (e === "formAction" ? (t !== "input" && dl(l, t, "name", u.name, u, null), dl(
            l,
            t,
            "formEncType",
            u.formEncType,
            u,
            null
          ), dl(
            l,
            t,
            "formMethod",
            u.formMethod,
            u,
            null
          ), dl(
            l,
            t,
            "formTarget",
            u.formTarget,
            u,
            null
          )) : (dl(l, t, "encType", u.encType, u, null), dl(l, t, "method", u.method, u, null), dl(l, t, "target", u.target, u, null)));
        if (a == null || typeof a == "symbol" || typeof a == "boolean") {
          l.removeAttribute(e);
          break;
        }
        a = Zu("" + a), l.setAttribute(e, a);
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
            throw Error(o(61));
          if (e = a.__html, e != null) {
            if (u.children != null) throw Error(o(60));
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
        e = Zu("" + a), l.setAttributeNS(
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
        I("beforetoggle", l), I("toggle", l), Xu(l, "popover", a);
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
        Xu(l, "is", a);
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        (!(2 < e.length) || e[0] !== "o" && e[0] !== "O" || e[1] !== "n" && e[1] !== "N") && (e = rm.get(e) || e, Xu(l, e, a));
    }
  }
  function ef(l, t, e, a, u, n) {
    switch (e) {
      case "style":
        If(l, a, n);
        break;
      case "dangerouslySetInnerHTML":
        if (a != null) {
          if (typeof a != "object" || !("__html" in a))
            throw Error(o(61));
          if (e = a.__html, e != null) {
            if (u.children != null) throw Error(o(60));
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
        if (!Zf.hasOwnProperty(e))
          l: {
            if (e[0] === "o" && e[1] === "n" && (u = e.endsWith("Capture"), t = e.slice(2, u ? e.length - 7 : void 0), n = l[$l] || null, n = n != null ? n[e] : null, typeof n == "function" && l.removeEventListener(t, n, u), typeof a == "function")) {
              typeof n != "function" && n !== null && (e in l ? l[e] = null : l.hasAttribute(e) && l.removeAttribute(e)), l.addEventListener(t, a, u);
              break l;
            }
            e in l ? l[e] = a : a === !0 ? l.setAttribute(e, "") : Xu(l, e, a);
          }
    }
  }
  function Gl(l, t, e) {
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
                  throw Error(o(137, t));
                default:
                  dl(l, t, n, i, e, null);
              }
          }
        u && dl(l, t, "srcSet", e.srcSet, e, null), a && dl(l, t, "src", e.src, e, null);
        return;
      case "input":
        I("invalid", l);
        var f = n = i = u = null, s = null, y = null;
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
                  f = b;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  if (b != null)
                    throw Error(o(137, t));
                  break;
                default:
                  dl(l, t, a, b, e, null);
              }
          }
        $f(
          l,
          n,
          f,
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
          if (e.hasOwnProperty(u) && (f = e[u], f != null))
            switch (u) {
              case "value":
                n = f;
                break;
              case "defaultValue":
                i = f;
                break;
              case "multiple":
                a = f;
              default:
                dl(l, t, u, f, e, null);
            }
        t = n, e = i, l.multiple = !!a, t != null ? ta(l, !!a, t, !1) : e != null && ta(l, !!a, e, !0);
        return;
      case "textarea":
        I("invalid", l), n = u = a = null;
        for (i in e)
          if (e.hasOwnProperty(i) && (f = e[i], f != null))
            switch (i) {
              case "value":
                a = f;
                break;
              case "defaultValue":
                u = f;
                break;
              case "children":
                n = f;
                break;
              case "dangerouslySetInnerHTML":
                if (f != null) throw Error(o(91));
                break;
              default:
                dl(l, t, i, f, e, null);
            }
        kf(l, a, u, n);
        return;
      case "option":
        for (s in e)
          e.hasOwnProperty(s) && (a = e[s], a != null) && (s === "selected" ? l.selected = a && typeof a != "function" && typeof a != "symbol" : dl(l, t, s, a, e, null));
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
        for (a = 0; a < pu.length; a++)
          I(pu[a], l);
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
                throw Error(o(137, t));
              default:
                dl(l, t, y, a, e, null);
            }
        return;
      default:
        if (yi(t)) {
          for (b in e)
            e.hasOwnProperty(b) && (a = e[b], a !== void 0 && ef(
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
    for (f in e)
      e.hasOwnProperty(f) && (a = e[f], a != null && dl(l, t, f, a, e, null));
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
        var u = null, n = null, i = null, f = null, s = null, y = null, b = null;
        for (S in e) {
          var T = e[S];
          if (e.hasOwnProperty(S) && T != null)
            switch (S) {
              case "checked":
                break;
              case "value":
                break;
              case "defaultValue":
                s = T;
              default:
                a.hasOwnProperty(S) || dl(l, t, S, null, a, T);
            }
        }
        for (var g in a) {
          var S = a[g];
          if (T = e[g], a.hasOwnProperty(g) && (S != null || T != null))
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
                f = S;
                break;
              case "children":
              case "dangerouslySetInnerHTML":
                if (S != null)
                  throw Error(o(137, t));
                break;
              default:
                S !== T && dl(
                  l,
                  t,
                  g,
                  S,
                  a,
                  T
                );
            }
        }
        hi(
          l,
          i,
          f,
          s,
          y,
          b,
          n,
          u
        );
        return;
      case "select":
        S = i = f = g = null;
        for (n in e)
          if (s = e[n], e.hasOwnProperty(n) && s != null)
            switch (n) {
              case "value":
                break;
              case "multiple":
                S = s;
              default:
                a.hasOwnProperty(n) || dl(
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
                f = n;
                break;
              case "multiple":
                i = n;
              default:
                n !== s && dl(
                  l,
                  t,
                  u,
                  n,
                  a,
                  s
                );
            }
        t = f, e = i, a = S, g != null ? ta(l, !!e, g, !1) : !!a != !!e && (t != null ? ta(l, !!e, t, !0) : ta(l, !!e, e ? [] : "", !1));
        return;
      case "textarea":
        S = g = null;
        for (f in e)
          if (u = e[f], e.hasOwnProperty(f) && u != null && !a.hasOwnProperty(f))
            switch (f) {
              case "value":
                break;
              case "children":
                break;
              default:
                dl(l, t, f, null, a, u);
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
                if (u != null) throw Error(o(91));
                break;
              default:
                u !== n && dl(l, t, i, u, a, n);
            }
        Wf(l, g, S);
        return;
      case "option":
        for (var H in e)
          g = e[H], e.hasOwnProperty(H) && g != null && !a.hasOwnProperty(H) && (H === "selected" ? l.selected = !1 : dl(
            l,
            t,
            H,
            null,
            a,
            g
          ));
        for (s in a)
          g = a[s], S = e[s], a.hasOwnProperty(s) && g !== S && (g != null || S != null) && (s === "selected" ? l.selected = g && typeof g != "function" && typeof g != "symbol" : dl(
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
        for (var Q in e)
          g = e[Q], e.hasOwnProperty(Q) && g != null && !a.hasOwnProperty(Q) && dl(l, t, Q, null, a, g);
        for (y in a)
          if (g = a[y], S = e[y], a.hasOwnProperty(y) && g !== S && (g != null || S != null))
            switch (y) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (g != null)
                  throw Error(o(137, t));
                break;
              default:
                dl(
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
        if (yi(t)) {
          for (var rl in e)
            g = e[rl], e.hasOwnProperty(rl) && g !== void 0 && !a.hasOwnProperty(rl) && ef(
              l,
              t,
              rl,
              void 0,
              a,
              g
            );
          for (b in a)
            g = a[b], S = e[b], !a.hasOwnProperty(b) || g === S || g === void 0 && S === void 0 || ef(
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
      g = e[h], e.hasOwnProperty(h) && g != null && !a.hasOwnProperty(h) && dl(l, t, h, null, a, g);
    for (T in a)
      g = a[T], S = e[T], !a.hasOwnProperty(T) || g === S || g == null && S == null || dl(l, t, T, g, a, S);
  }
  function lr(l) {
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
  function Xh() {
    if (typeof performance.getEntriesByType == "function") {
      for (var l = 0, t = 0, e = performance.getEntriesByType("resource"), a = 0; a < e.length; a++) {
        var u = e[a], n = u.transferSize, i = u.initiatorType, f = u.duration;
        if (n && f && lr(i)) {
          for (i = 0, f = u.responseEnd, a += 1; a < e.length; a++) {
            var s = e[a], y = s.startTime;
            if (y > f) break;
            var b = s.transferSize, T = s.initiatorType;
            b && lr(T) && (s = s.responseEnd, i += b * (s < f ? 1 : (f - y) / (s - y)));
          }
          if (--a, t += 8 * (n + i) / (u.duration / 1e3), l++, 10 < l) break;
        }
      }
      if (0 < l) return t / l / 1e6;
    }
    return navigator.connection && (l = navigator.connection.downlink, typeof l == "number") ? l : 5;
  }
  var af = null, uf = null;
  function Gn(l) {
    return l.nodeType === 9 ? l : l.ownerDocument;
  }
  function tr(l) {
    switch (l) {
      case "http://www.w3.org/2000/svg":
        return 1;
      case "http://www.w3.org/1998/Math/MathML":
        return 2;
      default:
        return 0;
    }
  }
  function er(l, t) {
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
  function nf(l, t) {
    return l === "textarea" || l === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.children == "bigint" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
  }
  var cf = null;
  function Qh() {
    var l = window.event;
    return l && l.type === "popstate" ? l === cf ? !1 : (cf = l, !0) : (cf = null, !1);
  }
  var ar = typeof setTimeout == "function" ? setTimeout : void 0, Lh = typeof clearTimeout == "function" ? clearTimeout : void 0, ur = typeof Promise == "function" ? Promise : void 0, Zh = typeof queueMicrotask == "function" ? queueMicrotask : typeof ur < "u" ? function(l) {
    return ur.resolve(null).then(l).catch(Vh);
  } : ar;
  function Vh(l) {
    setTimeout(function() {
      throw l;
    });
  }
  function pe(l) {
    return l === "head";
  }
  function nr(l, t) {
    var e = t, a = 0;
    do {
      var u = e.nextSibling;
      if (l.removeChild(e), u && u.nodeType === 8)
        if (e = u.data, e === "/$" || e === "/&") {
          if (a === 0) {
            l.removeChild(u), Ca(t);
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
            var i = n.nextSibling, f = n.nodeName;
            n[Xa] || f === "SCRIPT" || f === "STYLE" || f === "LINK" && n.rel.toLowerCase() === "stylesheet" || e.removeChild(n), n = i;
          }
        } else
          e === "body" && Au(l.ownerDocument.body);
      e = u;
    } while (e);
    Ca(t);
  }
  function ir(l, t) {
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
  function ff(l) {
    var t = l.firstChild;
    for (t && t.nodeType === 10 && (t = t.nextSibling); t; ) {
      var e = t;
      switch (t = t.nextSibling, e.nodeName) {
        case "HTML":
        case "HEAD":
        case "BODY":
          ff(e), ri(e);
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
        if (!l[Xa])
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
      if (l = jt(l.nextSibling), l === null) break;
    }
    return null;
  }
  function Jh(l, t, e) {
    if (t === "") return null;
    for (; l.nodeType !== 3; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !e || (l = jt(l.nextSibling), l === null)) return null;
    return l;
  }
  function cr(l, t) {
    for (; l.nodeType !== 8; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !t || (l = jt(l.nextSibling), l === null)) return null;
    return l;
  }
  function sf(l) {
    return l.data === "$?" || l.data === "$~";
  }
  function of(l) {
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
  function jt(l) {
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
  var df = null;
  function fr(l) {
    l = l.nextSibling;
    for (var t = 0; l; ) {
      if (l.nodeType === 8) {
        var e = l.data;
        if (e === "/$" || e === "/&") {
          if (t === 0)
            return jt(l.nextSibling);
          t--;
        } else
          e !== "$" && e !== "$!" && e !== "$?" && e !== "$~" && e !== "&" || t++;
      }
      l = l.nextSibling;
    }
    return null;
  }
  function sr(l) {
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
  function or(l, t, e) {
    switch (t = Gn(e), l) {
      case "html":
        if (l = t.documentElement, !l) throw Error(o(452));
        return l;
      case "head":
        if (l = t.head, !l) throw Error(o(453));
        return l;
      case "body":
        if (l = t.body, !l) throw Error(o(454));
        return l;
      default:
        throw Error(o(451));
    }
  }
  function Au(l) {
    for (var t = l.attributes; t.length; )
      l.removeAttributeNode(t[0]);
    ri(l);
  }
  var At = /* @__PURE__ */ new Map(), dr = /* @__PURE__ */ new Set();
  function Xn(l) {
    return typeof l.getRootNode == "function" ? l.getRootNode() : l.nodeType === 9 ? l : l.ownerDocument;
  }
  var Pt = U.d;
  U.d = {
    f: $h,
    r: Wh,
    D: kh,
    C: Fh,
    L: Ih,
    m: Ph,
    X: tv,
    S: lv,
    M: ev
  };
  function $h() {
    var l = Pt.f(), t = Dn();
    return l || t;
  }
  function Wh(l) {
    var t = Ie(l);
    t !== null && t.tag === 5 && t.type === "form" ? Oo(t) : Pt.r(l);
  }
  var Ma = typeof document > "u" ? null : document;
  function rr(l, t, e) {
    var a = Ma;
    if (a && typeof t == "string" && t) {
      var u = ht(t);
      u = 'link[rel="' + l + '"][href="' + u + '"]', typeof e == "string" && (u += '[crossorigin="' + e + '"]'), dr.has(u) || (dr.add(u), l = { rel: l, crossOrigin: e, href: t }, a.querySelector(u) === null && (t = a.createElement("link"), Gl(t, "link", l), Ul(t), a.head.appendChild(t)));
    }
  }
  function kh(l) {
    Pt.D(l), rr("dns-prefetch", l, null);
  }
  function Fh(l, t) {
    Pt.C(l, t), rr("preconnect", l, t);
  }
  function Ih(l, t, e) {
    Pt.L(l, t, e);
    var a = Ma;
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
          n = Da(l);
          break;
        case "script":
          n = Ua(l);
      }
      At.has(n) || (l = A(
        {
          rel: "preload",
          href: t === "image" && e && e.imageSrcSet ? void 0 : l,
          as: t
        },
        e
      ), At.set(n, l), a.querySelector(u) !== null || t === "style" && a.querySelector(zu(n)) || t === "script" && a.querySelector(Tu(n)) || (t = a.createElement("link"), Gl(t, "link", l), Ul(t), a.head.appendChild(t)));
    }
  }
  function Ph(l, t) {
    Pt.m(l, t);
    var e = Ma;
    if (e && l) {
      var a = t && typeof t.as == "string" ? t.as : "script", u = 'link[rel="modulepreload"][as="' + ht(a) + '"][href="' + ht(l) + '"]', n = u;
      switch (a) {
        case "audioworklet":
        case "paintworklet":
        case "serviceworker":
        case "sharedworker":
        case "worker":
        case "script":
          n = Ua(l);
      }
      if (!At.has(n) && (l = A({ rel: "modulepreload", href: l }, t), At.set(n, l), e.querySelector(u) === null)) {
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
        a = e.createElement("link"), Gl(a, "link", l), Ul(a), e.head.appendChild(a);
      }
    }
  }
  function lv(l, t, e) {
    Pt.S(l, t, e);
    var a = Ma;
    if (a && l) {
      var u = Pe(a).hoistableStyles, n = Da(l);
      t = t || "default";
      var i = u.get(n);
      if (!i) {
        var f = { loading: 0, preload: null };
        if (i = a.querySelector(
          zu(n)
        ))
          f.loading = 5;
        else {
          l = A(
            { rel: "stylesheet", href: l, "data-precedence": t },
            e
          ), (e = At.get(n)) && rf(l, e);
          var s = i = a.createElement("link");
          Ul(s), Gl(s, "link", l), s._p = new Promise(function(y, b) {
            s.onload = y, s.onerror = b;
          }), s.addEventListener("load", function() {
            f.loading |= 1;
          }), s.addEventListener("error", function() {
            f.loading |= 2;
          }), f.loading |= 4, Qn(i, t, a);
        }
        i = {
          type: "stylesheet",
          instance: i,
          count: 1,
          state: f
        }, u.set(n, i);
      }
    }
  }
  function tv(l, t) {
    Pt.X(l, t);
    var e = Ma;
    if (e && l) {
      var a = Pe(e).hoistableScripts, u = Ua(l), n = a.get(u);
      n || (n = e.querySelector(Tu(u)), n || (l = A({ src: l, async: !0 }, t), (t = At.get(u)) && mf(l, t), n = e.createElement("script"), Ul(n), Gl(n, "link", l), e.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, a.set(u, n));
    }
  }
  function ev(l, t) {
    Pt.M(l, t);
    var e = Ma;
    if (e && l) {
      var a = Pe(e).hoistableScripts, u = Ua(l), n = a.get(u);
      n || (n = e.querySelector(Tu(u)), n || (l = A({ src: l, async: !0, type: "module" }, t), (t = At.get(u)) && mf(l, t), n = e.createElement("script"), Ul(n), Gl(n, "link", l), e.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, a.set(u, n));
    }
  }
  function mr(l, t, e, a) {
    var u = (u = k.current) ? Xn(u) : null;
    if (!u) throw Error(o(446));
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
          )) && !n._p && (i.instance = n, i.state.loading = 5), At.has(l) || (e = {
            rel: "preload",
            as: "style",
            href: e.href,
            crossOrigin: e.crossOrigin,
            integrity: e.integrity,
            media: e.media,
            hrefLang: e.hrefLang,
            referrerPolicy: e.referrerPolicy
          }, At.set(l, e), n || av(
            u,
            l,
            e,
            i.state
          ))), t && a === null)
            throw Error(o(528, ""));
          return i;
        }
        if (t && a !== null)
          throw Error(o(529, ""));
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
        throw Error(o(444, l));
    }
  }
  function Da(l) {
    return 'href="' + ht(l) + '"';
  }
  function zu(l) {
    return 'link[rel="stylesheet"][' + l + "]";
  }
  function hr(l) {
    return A({}, l, {
      "data-precedence": l.precedence,
      precedence: null
    });
  }
  function av(l, t, e, a) {
    l.querySelector('link[rel="preload"][as="style"][' + t + "]") ? a.loading = 1 : (t = l.createElement("link"), a.preload = t, t.addEventListener("load", function() {
      return a.loading |= 1;
    }), t.addEventListener("error", function() {
      return a.loading |= 2;
    }), Gl(t, "link", e), Ul(t), l.head.appendChild(t));
  }
  function Ua(l) {
    return '[src="' + ht(l) + '"]';
  }
  function Tu(l) {
    return "script[async]" + l;
  }
  function vr(l, t, e) {
    if (t.count++, t.instance === null)
      switch (t.type) {
        case "style":
          var a = l.querySelector(
            'style[data-href~="' + ht(e.href) + '"]'
          );
          if (a)
            return t.instance = a, Ul(a), a;
          var u = A({}, e, {
            "data-href": e.href,
            "data-precedence": e.precedence,
            href: null,
            precedence: null
          });
          return a = (l.ownerDocument || l).createElement(
            "style"
          ), Ul(a), Gl(a, "style", u), Qn(a, e.precedence, l), t.instance = a;
        case "stylesheet":
          u = Da(e.href);
          var n = l.querySelector(
            zu(u)
          );
          if (n)
            return t.state.loading |= 4, t.instance = n, Ul(n), n;
          a = hr(e), (u = At.get(u)) && rf(a, u), n = (l.ownerDocument || l).createElement("link"), Ul(n);
          var i = n;
          return i._p = new Promise(function(f, s) {
            i.onload = f, i.onerror = s;
          }), Gl(n, "link", a), t.state.loading |= 4, Qn(n, e.precedence, l), t.instance = n;
        case "script":
          return n = Ua(e.src), (u = l.querySelector(
            Tu(n)
          )) ? (t.instance = u, Ul(u), u) : (a = e, (u = At.get(n)) && (a = A({}, e), mf(a, u)), l = l.ownerDocument || l, u = l.createElement("script"), Ul(u), Gl(u, "link", a), l.head.appendChild(u), t.instance = u);
        case "void":
          return null;
        default:
          throw Error(o(443, t.type));
      }
    else
      t.type === "stylesheet" && (t.state.loading & 4) === 0 && (a = t.instance, t.state.loading |= 4, Qn(a, e.precedence, l));
    return t.instance;
  }
  function Qn(l, t, e) {
    for (var a = e.querySelectorAll(
      'link[rel="stylesheet"][data-precedence],style[data-precedence]'
    ), u = a.length ? a[a.length - 1] : null, n = u, i = 0; i < a.length; i++) {
      var f = a[i];
      if (f.dataset.precedence === t) n = f;
      else if (n !== u) break;
    }
    n ? n.parentNode.insertBefore(l, n.nextSibling) : (t = e.nodeType === 9 ? e.head : e, t.insertBefore(l, t.firstChild));
  }
  function rf(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.title == null && (l.title = t.title);
  }
  function mf(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.integrity == null && (l.integrity = t.integrity);
  }
  var Ln = null;
  function yr(l, t, e) {
    if (Ln === null) {
      var a = /* @__PURE__ */ new Map(), u = Ln = /* @__PURE__ */ new Map();
      u.set(e, a);
    } else
      u = Ln, a = u.get(e), a || (a = /* @__PURE__ */ new Map(), u.set(e, a));
    if (a.has(l)) return a;
    for (a.set(l, null), e = e.getElementsByTagName(l), u = 0; u < e.length; u++) {
      var n = e[u];
      if (!(n[Xa] || n[Hl] || l === "link" && n.getAttribute("rel") === "stylesheet") && n.namespaceURI !== "http://www.w3.org/2000/svg") {
        var i = n.getAttribute(t) || "";
        i = l + i;
        var f = a.get(i);
        f ? f.push(n) : a.set(i, [n]);
      }
    }
    return a;
  }
  function gr(l, t, e) {
    l = l.ownerDocument || l, l.head.insertBefore(
      e,
      t === "title" ? l.querySelector("head > title") : null
    );
  }
  function uv(l, t, e) {
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
  function Sr(l) {
    return !(l.type === "stylesheet" && (l.state.loading & 3) === 0);
  }
  function nv(l, t, e, a) {
    if (e.type === "stylesheet" && (typeof a.media != "string" || matchMedia(a.media).matches !== !1) && (e.state.loading & 4) === 0) {
      if (e.instance === null) {
        var u = Da(a.href), n = t.querySelector(
          zu(u)
        );
        if (n) {
          t = n._p, t !== null && typeof t == "object" && typeof t.then == "function" && (l.count++, l = Zn.bind(l), t.then(l, l)), e.state.loading |= 4, e.instance = n, Ul(n);
          return;
        }
        n = t.ownerDocument || t, a = hr(a), (u = At.get(u)) && rf(a, u), n = n.createElement("link"), Ul(n);
        var i = n;
        i._p = new Promise(function(f, s) {
          i.onload = f, i.onerror = s;
        }), Gl(n, "link", a), e.instance = n;
      }
      l.stylesheets === null && (l.stylesheets = /* @__PURE__ */ new Map()), l.stylesheets.set(e, t), (t = e.state.preload) && (e.state.loading & 3) === 0 && (l.count++, e = Zn.bind(l), t.addEventListener("load", e), t.addEventListener("error", e));
    }
  }
  var hf = 0;
  function iv(l, t) {
    return l.stylesheets && l.count === 0 && Kn(l, l.stylesheets), 0 < l.count || 0 < l.imgCount ? function(e) {
      var a = setTimeout(function() {
        if (l.stylesheets && Kn(l, l.stylesheets), l.unsuspend) {
          var n = l.unsuspend;
          l.unsuspend = null, n();
        }
      }, 6e4 + t);
      0 < l.imgBytes && hf === 0 && (hf = 62500 * Xh());
      var u = setTimeout(
        function() {
          if (l.waitingForImages = !1, l.count === 0 && (l.stylesheets && Kn(l, l.stylesheets), l.unsuspend)) {
            var n = l.unsuspend;
            l.unsuspend = null, n();
          }
        },
        (l.imgBytes > hf ? 50 : 800) + t
      );
      return l.unsuspend = e, function() {
        l.unsuspend = null, clearTimeout(a), clearTimeout(u);
      };
    } : null;
  }
  function Zn() {
    if (this.count--, this.count === 0 && (this.imgCount === 0 || !this.waitingForImages)) {
      if (this.stylesheets) Kn(this, this.stylesheets);
      else if (this.unsuspend) {
        var l = this.unsuspend;
        this.unsuspend = null, l();
      }
    }
  }
  var Vn = null;
  function Kn(l, t) {
    l.stylesheets = null, l.unsuspend !== null && (l.count++, Vn = /* @__PURE__ */ new Map(), t.forEach(cv, l), Vn = null, Zn.call(l));
  }
  function cv(l, t) {
    if (!(t.state.loading & 4)) {
      var e = Vn.get(l);
      if (e) var a = e.get(null);
      else {
        e = /* @__PURE__ */ new Map(), Vn.set(l, e);
        for (var u = l.querySelectorAll(
          "link[data-precedence],style[data-precedence]"
        ), n = 0; n < u.length; n++) {
          var i = u[n];
          (i.nodeName === "LINK" || i.getAttribute("media") !== "not all") && (e.set(i.dataset.precedence, i), a = i);
        }
        a && e.set(null, a);
      }
      u = t.instance, i = u.getAttribute("data-precedence"), n = e.get(i) || a, n === a && e.set(null, u), e.set(i, u), this.count++, a = Zn.bind(this), u.addEventListener("load", a), u.addEventListener("error", a), n ? n.parentNode.insertBefore(u, n.nextSibling) : (l = l.nodeType === 9 ? l.head : l, l.insertBefore(u, l.firstChild)), t.state.loading |= 4;
    }
  }
  var xu = {
    $$typeof: El,
    Provider: null,
    Consumer: null,
    _currentValue: Z,
    _currentValue2: Z,
    _threadCount: 0
  };
  function fv(l, t, e, a, u, n, i, f, s) {
    this.tag = 1, this.containerInfo = l, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = fi(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = fi(0), this.hiddenUpdates = fi(null), this.identifierPrefix = a, this.onUncaughtError = u, this.onCaughtError = n, this.onRecoverableError = i, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = s, this.incompleteTransitions = /* @__PURE__ */ new Map();
  }
  function br(l, t, e, a, u, n, i, f, s, y, b, T) {
    return l = new fv(
      l,
      t,
      e,
      i,
      s,
      y,
      b,
      T,
      f
    ), t = 1, n === !0 && (t |= 24), n = ct(3, null, null, t), l.current = n, n.stateNode = l, t = Ji(), t.refCount++, l.pooledCache = t, t.refCount++, n.memoizedState = {
      element: a,
      isDehydrated: e,
      cache: t
    }, ki(n), l;
  }
  function pr(l) {
    return l ? (l = sa, l) : sa;
  }
  function jr(l, t, e, a, u, n) {
    u = pr(u), a.context === null ? a.context = u : a.pendingContext = u, a = se(t), a.payload = { element: e }, n = n === void 0 ? null : n, n !== null && (a.callback = n), e = oe(l, a, t), e !== null && (lt(e, l, t), au(e, l, t));
  }
  function Ar(l, t) {
    if (l = l.memoizedState, l !== null && l.dehydrated !== null) {
      var e = l.retryLane;
      l.retryLane = e !== 0 && e < t ? e : t;
    }
  }
  function vf(l, t) {
    Ar(l, t), (l = l.alternate) && Ar(l, t);
  }
  function zr(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = He(l, 67108864);
      t !== null && lt(t, l, 67108864), vf(l, 67108864);
    }
  }
  function Tr(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = rt();
      t = si(t);
      var e = He(l, t);
      e !== null && lt(e, l, t), vf(l, t);
    }
  }
  var Jn = !0;
  function sv(l, t, e, a) {
    var u = j.T;
    j.T = null;
    var n = U.p;
    try {
      U.p = 2, yf(l, t, e, a);
    } finally {
      U.p = n, j.T = u;
    }
  }
  function ov(l, t, e, a) {
    var u = j.T;
    j.T = null;
    var n = U.p;
    try {
      U.p = 8, yf(l, t, e, a);
    } finally {
      U.p = n, j.T = u;
    }
  }
  function yf(l, t, e, a) {
    if (Jn) {
      var u = gf(a);
      if (u === null)
        tf(
          l,
          t,
          a,
          wn,
          e
        ), Er(l, a);
      else if (rv(
        u,
        l,
        t,
        e,
        a
      ))
        a.stopPropagation();
      else if (Er(l, a), t & 4 && -1 < dv.indexOf(l)) {
        for (; u !== null; ) {
          var n = Ie(u);
          if (n !== null)
            switch (n.tag) {
              case 3:
                if (n = n.stateNode, n.current.memoizedState.isDehydrated) {
                  var i = Me(n.pendingLanes);
                  if (i !== 0) {
                    var f = n;
                    for (f.pendingLanes |= 2, f.entangledLanes |= 2; i; ) {
                      var s = 1 << 31 - nt(i);
                      f.entanglements[1] |= s, i &= ~s;
                    }
                    Rt(n), (nl & 6) === 0 && (_n = at() + 500, bu(0));
                  }
                }
                break;
              case 31:
              case 13:
                f = He(n, 2), f !== null && lt(f, n, 2), Dn(), vf(n, 2);
            }
          if (n = gf(a), n === null && tf(
            l,
            t,
            a,
            wn,
            e
          ), n === u) break;
          u = n;
        }
        u !== null && a.stopPropagation();
      } else
        tf(
          l,
          t,
          a,
          null,
          e
        );
    }
  }
  function gf(l) {
    return l = Si(l), Sf(l);
  }
  var wn = null;
  function Sf(l) {
    if (wn = null, l = Fe(l), l !== null) {
      var t = D(l);
      if (t === null) l = null;
      else {
        var e = t.tag;
        if (e === 13) {
          if (l = V(t), l !== null) return l;
          l = null;
        } else if (e === 31) {
          if (l = L(t), l !== null) return l;
          l = null;
        } else if (e === 3) {
          if (t.stateNode.current.memoizedState.isDehydrated)
            return t.tag === 3 ? t.stateNode.containerInfo : null;
          l = null;
        } else t !== l && (l = null);
      }
    }
    return wn = l, null;
  }
  function xr(l) {
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
          case Uf:
            return 2;
          case Cf:
            return 8;
          case Hu:
          case Fr:
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
  var bf = !1, je = null, Ae = null, ze = null, Eu = /* @__PURE__ */ new Map(), Nu = /* @__PURE__ */ new Map(), Te = [], dv = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
    " "
  );
  function Er(l, t) {
    switch (l) {
      case "focusin":
      case "focusout":
        je = null;
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
        Eu.delete(t.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        Nu.delete(t.pointerId);
    }
  }
  function Ou(l, t, e, a, u, n) {
    return l === null || l.nativeEvent !== n ? (l = {
      blockedOn: t,
      domEventName: e,
      eventSystemFlags: a,
      nativeEvent: n,
      targetContainers: [u]
    }, t !== null && (t = Ie(t), t !== null && zr(t)), l) : (l.eventSystemFlags |= a, t = l.targetContainers, u !== null && t.indexOf(u) === -1 && t.push(u), l);
  }
  function rv(l, t, e, a, u) {
    switch (t) {
      case "focusin":
        return je = Ou(
          je,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "dragenter":
        return Ae = Ou(
          Ae,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "mouseover":
        return ze = Ou(
          ze,
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
          Ou(
            Eu.get(n) || null,
            l,
            t,
            e,
            a,
            u
          )
        ), !0;
      case "gotpointercapture":
        return n = u.pointerId, Nu.set(
          n,
          Ou(
            Nu.get(n) || null,
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
  function Nr(l) {
    var t = Fe(l.target);
    if (t !== null) {
      var e = D(t);
      if (e !== null) {
        if (t = e.tag, t === 13) {
          if (t = V(e), t !== null) {
            l.blockedOn = t, Xf(l.priority, function() {
              Tr(e);
            });
            return;
          }
        } else if (t === 31) {
          if (t = L(e), t !== null) {
            l.blockedOn = t, Xf(l.priority, function() {
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
  function $n(l) {
    if (l.blockedOn !== null) return !1;
    for (var t = l.targetContainers; 0 < t.length; ) {
      var e = gf(l.nativeEvent);
      if (e === null) {
        e = l.nativeEvent;
        var a = new e.constructor(
          e.type,
          e
        );
        gi = a, e.target.dispatchEvent(a), gi = null;
      } else
        return t = Ie(e), t !== null && zr(t), l.blockedOn = e, !1;
      t.shift();
    }
    return !0;
  }
  function Or(l, t, e) {
    $n(l) && e.delete(t);
  }
  function mv() {
    bf = !1, je !== null && $n(je) && (je = null), Ae !== null && $n(Ae) && (Ae = null), ze !== null && $n(ze) && (ze = null), Eu.forEach(Or), Nu.forEach(Or);
  }
  function Wn(l, t) {
    l.blockedOn === t && (l.blockedOn = null, bf || (bf = !0, m.unstable_scheduleCallback(
      m.unstable_NormalPriority,
      mv
    )));
  }
  var kn = null;
  function _r(l) {
    kn !== l && (kn = l, m.unstable_scheduleCallback(
      m.unstable_NormalPriority,
      function() {
        kn === l && (kn = null);
        for (var t = 0; t < l.length; t += 3) {
          var e = l[t], a = l[t + 1], u = l[t + 2];
          if (typeof a != "function") {
            if (Sf(a || e) === null)
              continue;
            break;
          }
          var n = Ie(e);
          n !== null && (l.splice(t, 3), t -= 3, yc(
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
  function Ca(l) {
    function t(s) {
      return Wn(s, l);
    }
    je !== null && Wn(je, l), Ae !== null && Wn(Ae, l), ze !== null && Wn(ze, l), Eu.forEach(t), Nu.forEach(t);
    for (var e = 0; e < Te.length; e++) {
      var a = Te[e];
      a.blockedOn === l && (a.blockedOn = null);
    }
    for (; 0 < Te.length && (e = Te[0], e.blockedOn === null); )
      Nr(e), e.blockedOn === null && Te.shift();
    if (e = (l.ownerDocument || l).$$reactFormReplay, e != null)
      for (a = 0; a < e.length; a += 3) {
        var u = e[a], n = e[a + 1], i = u[$l] || null;
        if (typeof n == "function")
          i || _r(e);
        else if (i) {
          var f = null;
          if (n && n.hasAttribute("formAction")) {
            if (u = n, i = n[$l] || null)
              f = i.formAction;
            else if (Sf(u) !== null) continue;
          } else f = i.action;
          typeof f == "function" ? e[a + 1] = f : (e.splice(a, 3), a -= 3), _r(e);
        }
      }
  }
  function Mr() {
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
  function pf(l) {
    this._internalRoot = l;
  }
  Fn.prototype.render = pf.prototype.render = function(l) {
    var t = this._internalRoot;
    if (t === null) throw Error(o(409));
    var e = t.current, a = rt();
    jr(e, a, l, t, null, null);
  }, Fn.prototype.unmount = pf.prototype.unmount = function() {
    var l = this._internalRoot;
    if (l !== null) {
      this._internalRoot = null;
      var t = l.containerInfo;
      jr(l.current, 2, null, l, null, null), Dn(), t[ke] = null;
    }
  };
  function Fn(l) {
    this._internalRoot = l;
  }
  Fn.prototype.unstable_scheduleHydration = function(l) {
    if (l) {
      var t = Gf();
      l = { blockedOn: null, target: l, priority: t };
      for (var e = 0; e < Te.length && t !== 0 && t < Te[e].priority; e++) ;
      Te.splice(e, 0, l), e === 0 && Nr(l);
    }
  };
  var Dr = x.version;
  if (Dr !== "19.2.8")
    throw Error(
      o(
        527,
        Dr,
        "19.2.8"
      )
    );
  U.findDOMNode = function(l) {
    var t = l._reactInternals;
    if (t === void 0)
      throw typeof l.render == "function" ? Error(o(188)) : (l = Object.keys(l).join(","), Error(o(268, l)));
    return l = p(t), l = l !== null ? C(l) : null, l = l === null ? null : l.stateNode, l;
  };
  var hv = {
    bundleType: 0,
    version: "19.2.8",
    rendererPackageName: "react-dom",
    currentDispatcherRef: j,
    reconcilerVersion: "19.2.8"
  };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var In = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!In.isDisabled && In.supportsFiber)
      try {
        Ba = In.inject(
          hv
        ), ut = In;
      } catch {
      }
  }
  return Mu.createRoot = function(l, t) {
    if (!M(l)) throw Error(o(299));
    var e = !1, a = "", u = Yo, n = Go, i = Xo;
    return t != null && (t.unstable_strictMode === !0 && (e = !0), t.identifierPrefix !== void 0 && (a = t.identifierPrefix), t.onUncaughtError !== void 0 && (u = t.onUncaughtError), t.onCaughtError !== void 0 && (n = t.onCaughtError), t.onRecoverableError !== void 0 && (i = t.onRecoverableError)), t = br(
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
      Mr
    ), l[ke] = t.current, lf(l), new pf(t);
  }, Mu.hydrateRoot = function(l, t, e) {
    if (!M(l)) throw Error(o(299));
    var a = !1, u = "", n = Yo, i = Go, f = Xo, s = null;
    return e != null && (e.unstable_strictMode === !0 && (a = !0), e.identifierPrefix !== void 0 && (u = e.identifierPrefix), e.onUncaughtError !== void 0 && (n = e.onUncaughtError), e.onCaughtError !== void 0 && (i = e.onCaughtError), e.onRecoverableError !== void 0 && (f = e.onRecoverableError), e.formState !== void 0 && (s = e.formState)), t = br(
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
      f,
      Mr
    ), t.context = pr(null), e = t.current, a = rt(), a = si(a), u = se(a), u.callback = null, oe(e, u, a), e = a, t.current.lanes = e, Ga(t, e), Rt(t), l[ke] = t.current, lf(l), new Fn(t);
  }, Mu.version = "19.2.8", Mu;
}
var Qr;
function Tv() {
  if (Qr) return zf.exports;
  Qr = 1;
  function m() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(m);
      } catch (x) {
        console.error(x);
      }
  }
  return m(), zf.exports = zv(), zf.exports;
}
var xv = Tv();
class Ev extends Error {
  constructor(x, _, o) {
    super(x), this.status = _, this.payload = o;
  }
  status;
  payload;
}
async function tt(m, x = {}) {
  const _ = new Headers(x.headers);
  x.body && !_.has("content-type") && _.set("content-type", "application/json");
  const o = await fetch(m, { ...x, headers: _, credentials: "same-origin" });
  let M = {};
  try {
    M = await o.json();
  } catch {
  }
  if (!o.ok) {
    const D = M && typeof M == "object" ? M : {}, V = typeof D.error == "string" ? D.error : typeof D.message == "string" ? D.message : `Request failed (${o.status})`;
    throw new Ev(V, o.status, M);
  }
  return M;
}
const et = {
  commandCenter: () => tt("/api/console/command-center"),
  work: () => tt("/api/console/requirements"),
  workPortfolio: () => tt("/api/console/work-portfolio"),
  automations: () => tt("/api/console/automations"),
  automationSettings: () => tt("/api/console/automation-settings"),
  connector: () => tt("/api/console/connector/status"),
  advanced: () => tt("/api/console/advanced"),
  automationAction: (m, x, _, o) => tt(`/api/console/automations/${encodeURIComponent(m)}/${encodeURIComponent(x)}/${encodeURIComponent(_)}/${encodeURIComponent(o)}`, { method: "POST", body: "{}" }),
  providerAction: (m, x) => tt(`/api/console/providers/${encodeURIComponent(m)}/${x}`, { method: "POST", body: "{}" }),
  providerHealth: (m) => tt("/api/console/providers/health", { method: "POST", body: JSON.stringify({ providerId: m }) }),
  localToolAction: (m, x) => tt(`/api/console/local-tools/${encodeURIComponent(m)}/${x}`, { method: "POST", body: "{}" }),
  localToolHealth: (m) => tt("/api/console/local-tools/health", { method: "POST", body: JSON.stringify({ toolId: m }) }),
  registerRepository: (m, x) => tt("/api/repositories/register", { method: "POST", body: JSON.stringify({ path: m, displayName: x }) }),
  removeRepository: (m) => tt(`/api/repositories/${encodeURIComponent(m)}/remove`, { method: "POST", body: "{}" })
}, Vr = [
  { id: "overview", label: "Overview", group: "daily" },
  { id: "automations", label: "Automations", group: "daily" },
  { id: "work", label: "Work", group: "daily" },
  { id: "capabilities", label: "Capabilities", group: "manage" },
  { id: "repositories", label: "Repositories", group: "manage" },
  { id: "settings", label: "Settings", group: "manage" },
  { id: "system", label: "System", group: "system" }
];
function Lr() {
  const m = location.hash.replace(/^#\/?/, "").split("/")[0];
  return Vr.some((x) => x.id === m) ? m : "overview";
}
function le({ children: m, ...x }) {
  return /* @__PURE__ */ c.jsx("svg", { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: "1.55", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", ...x, children: m });
}
const Nv = (m) => /* @__PURE__ */ c.jsx(le, { ...m, children: /* @__PURE__ */ c.jsx("path", { d: "M3 9.2 10 3l7 6.2v7.1a.7.7 0 0 1-.7.7h-4.2v-5H7.9v5H3.7a.7.7 0 0 1-.7-.7z" }) }), Ov = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4.2 6.3A6.5 6.5 0 0 1 16 7" }),
  /* @__PURE__ */ c.jsx("path", { d: "m16 3 .4 4.4-4.4.4" }),
  /* @__PURE__ */ c.jsx("path", { d: "M15.8 13.7A6.5 6.5 0 0 1 4 13" }),
  /* @__PURE__ */ c.jsx("path", { d: "m4 17-.4-4.4 4.4-.4" })
] }), _v = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4 5.2h12v10.6H4z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M7 5.2V3.6h6v1.6M7 9h6M7 12h4" })
] }), Mv = (m) => /* @__PURE__ */ c.jsx(le, { ...m, children: /* @__PURE__ */ c.jsx("path", { d: "m10 2.8 2 4 4.4.7-3.2 3.1.8 4.4-4-2.1L6 15l.8-4.4-3.2-3.1L8 6.8z" }) }), Dv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4 3.5h5l1.4 2H16v11H4z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M4 8h12" })
] }), Uv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("circle", { cx: "10", cy: "10", r: "2.5" }),
  /* @__PURE__ */ c.jsx("path", { d: "M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" })
] }), Cv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M3.2 4.5h13.6v9.2H3.2z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M7 17h6M10 13.7V17" })
] }), Rv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M15.5 6A6 6 0 1 0 16 12" }),
  /* @__PURE__ */ c.jsx("path", { d: "m15.5 2.8.3 3.7-3.7.2" })
] }), Hv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("circle", { cx: "8.8", cy: "8.8", r: "5" }),
  /* @__PURE__ */ c.jsx("path", { d: "m12.5 12.5 4 4" })
] }), qv = { overview: Nv, automations: Ov, work: _v, capabilities: Mv, repositories: Dv, settings: Uv, system: Cv }, Bv = { daily: "Workspace", manage: "Configure", system: "System" };
function Yv({ route: m }) {
  let x = "";
  return /* @__PURE__ */ c.jsxs("aside", { className: "sidebar", children: [
    /* @__PURE__ */ c.jsxs("div", { className: "brand", children: [
      /* @__PURE__ */ c.jsx("span", { className: "brand-mark", children: "F" }),
      /* @__PURE__ */ c.jsxs("div", { children: [
        /* @__PURE__ */ c.jsx("strong", { children: "Forge" }),
        /* @__PURE__ */ c.jsx("small", { children: "Utility Console" })
      ] })
    ] }),
    /* @__PURE__ */ c.jsx("nav", { children: Vr.map((_) => {
      const o = qv[_.id], M = _.group !== x;
      return x = _.group, /* @__PURE__ */ c.jsxs("div", { className: M ? "nav-group-start" : "nav-item", children: [
        M && /* @__PURE__ */ c.jsx("div", { className: "nav-group-label", children: Bv[_.group] }),
        /* @__PURE__ */ c.jsxs("a", { href: `#/${_.id}`, className: m === _.id ? "active" : "", children: [
          /* @__PURE__ */ c.jsx(o, {}),
          /* @__PURE__ */ c.jsx("span", { children: _.label })
        ] })
      ] }, _.id);
    }) }),
    /* @__PURE__ */ c.jsxs("div", { className: "sidebar-foot", children: [
      /* @__PURE__ */ c.jsx("span", { className: "pulse-dot" }),
      /* @__PURE__ */ c.jsxs("span", { children: [
        /* @__PURE__ */ c.jsx("strong", { children: "Runtime connected" }),
        /* @__PURE__ */ c.jsx("small", { children: "ChatGPT remains the primary workspace" })
      ] })
    ] })
  ] });
}
function Gv({ route: m, children: x }) {
  return /* @__PURE__ */ c.jsxs("div", { className: "app-shell", children: [
    /* @__PURE__ */ c.jsx(Yv, { route: m }),
    /* @__PURE__ */ c.jsx("main", { className: "workspace", children: x })
  ] });
}
function Ee(m) {
  if (!m) return "—";
  const x = new Date(m);
  return Number.isNaN(x.getTime()) ? m : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: !1 }).format(x);
}
function zt(m, x = 86) {
  const _ = (m ?? "").trim();
  return _.length > x ? `${_.slice(0, x - 1)}…` : _;
}
function Ra(m, x = "—") {
  return typeof m == "string" && m.trim() ? m : String(m ?? x);
}
function li(m) {
  return JSON.stringify(m ?? {}, null, 2);
}
function $e({ eyebrow: m, title: x, description: _, refreshedAt: o, busy: M, onRefresh: D, actions: V }) {
  return /* @__PURE__ */ c.jsxs("header", { className: "command-bar", children: [
    /* @__PURE__ */ c.jsxs("div", { className: "command-title", children: [
      m && /* @__PURE__ */ c.jsx("div", { className: "eyebrow", children: m }),
      /* @__PURE__ */ c.jsx("h1", { children: x }),
      /* @__PURE__ */ c.jsx("p", { children: _ })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "command-actions", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "command-meta", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Last synced" }),
        /* @__PURE__ */ c.jsx("strong", { children: Ee(o) })
      ] }),
      /* @__PURE__ */ c.jsx("button", { className: "icon-button", onClick: D, disabled: M, title: "Refresh", children: /* @__PURE__ */ c.jsx(Rv, {}) }),
      V,
      /* @__PURE__ */ c.jsx("a", { className: "button ghost-link", href: "https://chatgpt.com", target: "_blank", rel: "noreferrer", children: "Open ChatGPT ↗" })
    ] })
  ] });
}
function Xv(m) {
  const x = (m ?? "").toLowerCase();
  return /ready|enabled|healthy|success|done|completed|active/.test(x) ? "success" : /attention|blocked|error|fail|danger/.test(x) ? "danger" : /pause|waiting|warn|degrad|stale|planned/.test(x) ? "warning" : /info|running/.test(x) ? "info" : "neutral";
}
function Ll({ label: m, tone: x }) {
  const _ = x && ["success", "warning", "danger", "info", "neutral"].includes(x) ? x : Xv(x ?? m);
  return /* @__PURE__ */ c.jsxs("span", { className: "status-text", children: [
    /* @__PURE__ */ c.jsx("i", { className: `status-dot ${_}` }),
    m
  ] });
}
function Uu({ title: m, meta: x, actions: _ }) {
  return /* @__PURE__ */ c.jsxs("div", { className: "section-header", children: [
    /* @__PURE__ */ c.jsxs("div", { children: [
      /* @__PURE__ */ c.jsx("h2", { children: m }),
      x && /* @__PURE__ */ c.jsx("span", { children: x })
    ] }),
    _ && /* @__PURE__ */ c.jsx("div", { children: _ })
  ] });
}
function Kr(m) {
  return m.advanced?.status ?? "";
}
function Qv(m) {
  return ["open", "running", "ready"].includes(Kr(m));
}
function Ha(m) {
  return ["blocked", "failed"].includes(Kr(m));
}
function Nf(m) {
  return `${String(m.title ?? "")}:${String(m.reason ?? "")}`;
}
function Lv(m) {
  const x = /* @__PURE__ */ new Map(), _ = new Map(m.workPortfolio.repositories.map((o) => [o.repoId, o.repositoryName]));
  for (const o of m.workPortfolio.items) {
    if (!Qv(o) && !Ha(o)) continue;
    const M = x.get(o.repoId) ?? {
      repoId: o.repoId,
      repositoryName: o.repositoryName || _.get(o.repoId) || o.repoId,
      activeCount: 0,
      attentionCount: 0,
      updatedAt: o.updatedAt,
      items: []
    };
    M.activeCount += 1, Ha(o) && (M.attentionCount += 1), o.updatedAt > M.updatedAt && (M.updatedAt = o.updatedAt), M.items.push(o), x.set(o.repoId, M);
  }
  return [...x.values()].map((o) => ({
    ...o,
    items: [...o.items].sort((M, D) => Number(Ha(D)) - Number(Ha(M)) || D.updatedAt.localeCompare(M.updatedAt))
  })).sort((o, M) => {
    const D = M.attentionCount - o.attentionCount, V = M.activeCount - o.activeCount;
    return D || V || M.updatedAt.localeCompare(o.updatedAt);
  });
}
function Zv({ data: m, busy: x, onRefresh: _ }) {
  const o = m.commandCenter, M = m.automations.summary, D = o.pluginSummary ?? {}, V = o.repositories ?? [], L = o.readiness ?? {}, O = Lv(m), p = O.slice(0, 8), C = m.workPortfolio.items.filter(Ha).slice(0, 4), A = [...o.handoffs ?? []].filter((q, K, El) => El.findIndex((Xl) => Nf(Xl) === Nf(q)) === K), N = [
    ...C.map((q) => ({
      key: `work:${q.id}`,
      repositoryName: q.repositoryName,
      title: q.title,
      summary: zt(q.latestSummary || q.nextAction, 108),
      statusLabel: q.statusLabel,
      tone: q.tone ?? "warning",
      href: "#/work"
    })),
    ...A.slice(0, 2).map((q, K) => ({
      key: `handoff:${K}:${Nf(q)}`,
      title: String(q.title ?? "Needs review"),
      summary: zt(String(q.reason ?? q.summary ?? "Review in ChatGPT"), 108),
      statusLabel: String(q.statusLabel ?? "Review"),
      tone: String(q.tone ?? "warning"),
      href: "#/work"
    })),
    ...(D.needsAttention ?? 0) > 0 ? [{
      key: "capabilities",
      title: "Capabilities need attention",
      summary: `${D.needsAttention} configured capabilities need inspection`,
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/capabilities"
    }] : []
  ].filter((q, K, El) => El.findIndex((Xl) => Xl.key === q.key) === K).slice(0, 5), G = String(L.state ?? L.status ?? "ready"), jl = /error|failed|blocked|unavailable|degraded|warning|attention/i.test(G), Al = String(L.label ?? L.headline ?? (jl ? "Runtime needs attention" : "Ready")), Rl = D.total ?? (o.plugins ?? []).length;
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx(
      $e,
      {
        eyebrow: "FORGE CONTROL PLANE",
        title: "Overview",
        description: "仓库活动、待处理事项和 Forge 可用性概览。",
        refreshedAt: m.generatedAt,
        busy: x,
        onRefresh: _
      }
    ),
    jl && /* @__PURE__ */ c.jsxs("a", { className: "overview-runtime-alert", href: "#/system", children: [
      /* @__PURE__ */ c.jsx(Ll, { label: Al, tone: G }),
      /* @__PURE__ */ c.jsx("span", { children: zt(String(L.explanation ?? L.summary ?? "Inspect Runtime diagnostics."), 150) }),
      /* @__PURE__ */ c.jsx("strong", { children: "Inspect →" })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "overview-v2-grid", children: [
      /* @__PURE__ */ c.jsx("main", { className: "overview-v2-main", children: /* @__PURE__ */ c.jsxs("section", { className: "page-section overview-activity-section", children: [
        /* @__PURE__ */ c.jsx(Uu, { title: "Repository activity", meta: `${V.length} repositories` }),
        p.length ? /* @__PURE__ */ c.jsx("div", { className: "overview-activity-list", children: p.map((q) => /* @__PURE__ */ c.jsxs("a", { className: "repo-activity-row", href: "#/work", children: [
          /* @__PURE__ */ c.jsxs("div", { className: "repo-activity-copy", children: [
            /* @__PURE__ */ c.jsxs("div", { className: "repo-activity-title", children: [
              /* @__PURE__ */ c.jsx("strong", { children: q.repositoryName }),
              /* @__PURE__ */ c.jsxs("span", { children: [
                q.activeCount,
                " active"
              ] }),
              q.attentionCount > 0 && /* @__PURE__ */ c.jsxs("span", { className: "repo-attention-count", children: [
                q.attentionCount,
                " attention"
              ] })
            ] }),
            /* @__PURE__ */ c.jsx("div", { className: "repo-work-lines", children: q.items.slice(0, 2).map((K) => /* @__PURE__ */ c.jsxs("div", { className: "repo-work-line", children: [
              /* @__PURE__ */ c.jsx("span", { children: zt(K.title, 88) }),
              Ha(K) && /* @__PURE__ */ c.jsx(Ll, { label: K.statusLabel, tone: K.tone ?? "warning" })
            ] }, K.id)) })
          ] }),
          /* @__PURE__ */ c.jsx("div", { className: "repo-activity-meta", children: Ee(q.updatedAt) })
        ] }, q.repoId)) }) : /* @__PURE__ */ c.jsx("div", { className: "overview-empty-line", children: "No active repository work." }),
        O.length > p.length && /* @__PURE__ */ c.jsx("a", { className: "overview-more-link", href: "#/work", children: "View all work →" })
      ] }) }),
      /* @__PURE__ */ c.jsxs("aside", { className: "overview-context-rail", children: [
        /* @__PURE__ */ c.jsxs("section", { className: "overview-context-section", children: [
          /* @__PURE__ */ c.jsx(Uu, { title: "Needs attention", meta: N.length ? String(N.length) : "All clear" }),
          N.length ? /* @__PURE__ */ c.jsx("div", { className: "overview-attention-list", children: N.map((q) => /* @__PURE__ */ c.jsxs("a", { className: "overview-attention-row", href: q.href, children: [
            /* @__PURE__ */ c.jsxs("div", { className: "overview-attention-copy", children: [
              q.repositoryName && /* @__PURE__ */ c.jsx("span", { children: q.repositoryName }),
              /* @__PURE__ */ c.jsx("strong", { children: zt(q.title, 72) }),
              /* @__PURE__ */ c.jsx("p", { children: q.summary })
            ] }),
            /* @__PURE__ */ c.jsx(Ll, { label: q.statusLabel, tone: q.tone })
          ] }, q.key)) }) : /* @__PURE__ */ c.jsx("div", { className: "overview-empty-line", children: "No action needed." })
        ] }),
        /* @__PURE__ */ c.jsxs("section", { className: "overview-context-section overview-system-section", children: [
          /* @__PURE__ */ c.jsx(Uu, { title: "System", meta: "Coarse state" }),
          /* @__PURE__ */ c.jsxs("div", { className: "overview-system-list", children: [
            /* @__PURE__ */ c.jsxs("a", { className: "overview-system-row", href: "#/system", children: [
              /* @__PURE__ */ c.jsx("span", { children: "Runtime" }),
              /* @__PURE__ */ c.jsx(Ll, { label: Al, tone: G })
            ] }),
            /* @__PURE__ */ c.jsxs("a", { className: "overview-system-row", href: "#/automations", children: [
              /* @__PURE__ */ c.jsx("span", { children: "Automations" }),
              /* @__PURE__ */ c.jsxs("strong", { children: [
                M.enabled,
                " enabled",
                M.paused ? ` · ${M.paused} paused` : ""
              ] })
            ] }),
            /* @__PURE__ */ c.jsxs("a", { className: "overview-system-row", href: "#/capabilities", children: [
              /* @__PURE__ */ c.jsx("span", { children: "Capabilities" }),
              /* @__PURE__ */ c.jsxs("strong", { children: [
                D.ready ?? 0,
                " / ",
                Rl,
                " ready"
              ] })
            ] }),
            /* @__PURE__ */ c.jsxs("a", { className: "overview-system-row", href: "#/repositories", children: [
              /* @__PURE__ */ c.jsx("span", { children: "Repositories" }),
              /* @__PURE__ */ c.jsx("strong", { children: V.length })
            ] })
          ] })
        ] })
      ] })
    ] })
  ] });
}
function _f({ items: m, value: x, onChange: _ }) {
  return /* @__PURE__ */ c.jsx("div", { className: "segmented", role: "tablist", children: m.map((o) => /* @__PURE__ */ c.jsxs("button", { role: "tab", "aria-selected": x === o.id, className: x === o.id ? "selected" : "", onClick: () => _(o.id), children: [
    o.label,
    o.count !== void 0 && /* @__PURE__ */ c.jsx("span", { children: o.count })
  ] }, o.id)) });
}
function ti({ title: m, subtitle: x, actions: _, children: o, empty: M }) {
  return /* @__PURE__ */ c.jsx("aside", { className: "detail-pane", children: m ? /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsxs("div", { className: "detail-head", children: [
      /* @__PURE__ */ c.jsxs("div", { children: [
        /* @__PURE__ */ c.jsx("div", { className: "eyebrow", children: "DETAIL" }),
        /* @__PURE__ */ c.jsx("h2", { children: m }),
        x && /* @__PURE__ */ c.jsx("p", { children: x })
      ] }),
      _ && /* @__PURE__ */ c.jsx("div", { className: "detail-actions", children: _ })
    ] }),
    /* @__PURE__ */ c.jsx("div", { className: "detail-body", children: o })
  ] }) : /* @__PURE__ */ c.jsx("div", { className: "detail-empty", children: M ?? "选择一项查看详细配置" }) });
}
function Cu({ items: m }) {
  return /* @__PURE__ */ c.jsx("dl", { className: "definition-list", children: m.map(([x, _]) => /* @__PURE__ */ c.jsxs("div", { children: [
    /* @__PURE__ */ c.jsx("dt", { children: x }),
    /* @__PURE__ */ c.jsx("dd", { children: _ })
  ] }, x)) });
}
function Ne({ children: m, className: x = "", ..._ }) {
  return /* @__PURE__ */ c.jsx("button", { className: `button ${x}`.trim(), ..._, children: m });
}
function Vv({ data: m, busy: x, onRefresh: _, onAction: o }) {
  const M = m.automations.automations, [D, V] = gl.useState("enabled"), L = gl.useMemo(() => M.filter((N) => D === "all" || N.status === D), [M, D]), [O, p] = gl.useState(), C = (N) => `${N.source}:${N.repoId}:${N.id}`, A = L.find((N) => C(N) === O) ?? L[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "LONG-RUNNING CONFIG", title: "Automations", description: "管理 Forge 持久化 Schedule 与 Assistant Routine；结果正文继续发送到 ChatGPT / Email。", refreshedAt: m.automations.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ c.jsx("div", { className: "toolbar", children: /* @__PURE__ */ c.jsx(_f, { value: D, onChange: V, items: [{ id: "enabled", label: "Enabled", count: M.filter((N) => N.status === "enabled").length }, { id: "paused", label: "Paused", count: M.filter((N) => N.status === "paused").length }, { id: "attention", label: "Attention", count: M.filter((N) => N.status === "attention").length }, { id: "all", label: "All", count: M.length }] }) }),
    /* @__PURE__ */ c.jsxs("div", { className: "split-workspace automation-layout", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "table-wrap", children: [
        /* @__PURE__ */ c.jsxs("table", { className: "data-table", children: [
          /* @__PURE__ */ c.jsx("thead", { children: /* @__PURE__ */ c.jsxs("tr", { children: [
            /* @__PURE__ */ c.jsx("th", { children: "Automation" }),
            /* @__PURE__ */ c.jsx("th", { children: "Schedule" }),
            /* @__PURE__ */ c.jsx("th", { children: "Delivery" }),
            /* @__PURE__ */ c.jsx("th", { children: "Status" }),
            /* @__PURE__ */ c.jsx("th", { children: "Last" }),
            /* @__PURE__ */ c.jsx("th", { children: "Next" })
          ] }) }),
          /* @__PURE__ */ c.jsx("tbody", { children: L.map((N) => /* @__PURE__ */ c.jsxs("tr", { className: A && C(A) === C(N) ? "selected" : "", onClick: () => p(C(N)), children: [
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx("strong", { children: N.name }),
              /* @__PURE__ */ c.jsxs("small", { children: [
                N.repositoryName,
                " · ",
                N.source
              ] })
            ] }),
            /* @__PURE__ */ c.jsx("td", { children: N.schedule }),
            /* @__PURE__ */ c.jsx("td", { children: N.delivery ?? "—" }),
            /* @__PURE__ */ c.jsx("td", { children: /* @__PURE__ */ c.jsx(Ll, { label: N.status, tone: N.status }) }),
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx("span", { children: zt(N.lastResult, 30) || "—" }),
              /* @__PURE__ */ c.jsx("small", { children: Ee(N.lastRunAt) })
            ] }),
            /* @__PURE__ */ c.jsx("td", { children: Ee(N.nextRunHint) })
          ] }, C(N))) })
        ] }),
        !L.length && /* @__PURE__ */ c.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Automation。" })
      ] }),
      /* @__PURE__ */ c.jsx(ti, { title: A?.name, subtitle: A?.summary, empty: "选择一个 Automation 查看配置", children: A && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Cu, { items: [["Status", /* @__PURE__ */ c.jsx(Ll, { label: A.status, tone: A.status })], ["Schedule", A.schedule], ["Source", A.source], ["Repository", A.repositoryName], ["Delivery", A.delivery ?? "—"], ["Last result", A.lastResult ?? "—"], ["Last run", Ee(A.lastRunAt)], ["Next", Ee(A.nextRunHint)]] }),
        A.pausedReason && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Paused reason" }),
          /* @__PURE__ */ c.jsx("p", { children: A.pausedReason })
        ] }),
        /* @__PURE__ */ c.jsx("div", { className: "detail-button-row", children: A.actions.map((N) => /* @__PURE__ */ c.jsx(Ne, { disabled: x, className: N === "pause" ? "danger-text" : "", onClick: () => {
          o(A, N);
        }, children: N === "run" ? "Run now" : N === "pause" ? "Pause" : "Resume" }, N)) }),
        /* @__PURE__ */ c.jsx("p", { className: "detail-note", children: "这里只保存调度配置与最近一次结果摘要，不复制日报、SEO 或研究正文。" })
      ] }) })
    ] })
  ] });
}
function Kv(m) {
  return m.advanced?.status ?? "";
}
function Pn(m, x) {
  const _ = Kv(m);
  return x === "all" ? !0 : x === "attention" ? _ === "blocked" || _ === "failed" : x === "completed" ? _ === "completed" || _ === "cancelled" : _ === "open" || _ === "running" || _ === "ready";
}
function Jv({ data: m, busy: x, onRefresh: _ }) {
  const o = m.workPortfolio, M = o.items ?? [], [D, V] = gl.useState("open"), [L, O] = gl.useState("all"), [p, C] = gl.useState(), A = gl.useMemo(() => M.filter((G) => Pn(G, D) && (L === "all" || G.repoId === L)), [M, D, L]), N = A.find((G) => G.id === p) ?? A[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "EXECUTION WORK", title: "Work", description: "查看所有已注册仓库的持久 Work；仓库是归属维度，默认聚合展示。", refreshedAt: o.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ c.jsxs("div", { className: "toolbar work-toolbar", children: [
      /* @__PURE__ */ c.jsx(_f, { value: D, onChange: V, items: [{ id: "open", label: "Open", count: M.filter((G) => Pn(G, "open")).length }, { id: "attention", label: "Needs attention", count: M.filter((G) => Pn(G, "attention")).length }, { id: "completed", label: "Completed", count: M.filter((G) => Pn(G, "completed")).length }, { id: "all", label: "All", count: M.length }] }),
      /* @__PURE__ */ c.jsxs("label", { className: "repository-filter", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Repository" }),
        /* @__PURE__ */ c.jsxs("select", { value: L, onChange: (G) => {
          O(G.target.value), C(void 0);
        }, children: [
          /* @__PURE__ */ c.jsx("option", { value: "all", children: "All repositories" }),
          o.repositories.map((G) => /* @__PURE__ */ c.jsx("option", { value: G.repoId, children: G.repositoryName }, G.repoId))
        ] })
      ] })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "scan-list", children: [
        A.map((G) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row work-row ${N?.id === G.id ? "selected" : ""}`, onClick: () => C(G.id), children: [
          /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
            /* @__PURE__ */ c.jsx("span", { className: "row-eyebrow", children: G.repositoryName }),
            /* @__PURE__ */ c.jsx("strong", { children: G.title }),
            /* @__PURE__ */ c.jsx("p", { children: zt(G.latestSummary || G.objective, 108) })
          ] }),
          /* @__PURE__ */ c.jsxs("div", { className: "scan-meta", children: [
            /* @__PURE__ */ c.jsx(Ll, { label: G.statusLabel, tone: G.tone }),
            /* @__PURE__ */ c.jsx("time", { children: Ee(G.updatedAt) })
          ] })
        ] }, G.id)),
        !A.length && /* @__PURE__ */ c.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Work。" })
      ] }),
      /* @__PURE__ */ c.jsx(ti, { title: N?.title, subtitle: N?.objective, empty: "选择一个 Work 查看完整上下文", children: N && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Cu, { items: [["Repository", N.repositoryName], ["Status", /* @__PURE__ */ c.jsx(Ll, { label: N.statusLabel, tone: N.tone })], ["Updated", Ee(N.updatedAt)], ["Work id", /* @__PURE__ */ c.jsx("code", { children: N.id })]] }),
        N.latestSummary && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Latest" }),
          /* @__PURE__ */ c.jsx("p", { children: N.latestSummary })
        ] }),
        /* @__PURE__ */ c.jsx("p", { className: "detail-note", children: "这里聚合所有仓库的持久 Work。具体执行、检查和继续操作仍由 ChatGPT 主控。" })
      ] }) })
    ] })
  ] });
}
function Du(m) {
  const x = `${m.name} ${m.provider} ${(m.capabilityLabels ?? []).join(" ")}`.toLowerCase();
  return /gmail|calendar|github|google task|notion/.test(x) ? "services" : /browser|desktop|ios|repository|codegraph|local/.test(x) ? "execution" : "extensions";
}
function wv({ data: m, busy: x, onRefresh: _ }) {
  const o = m.commandCenter.plugins ?? [], M = m.automationSettings.providers ?? [], [D, V] = gl.useState("all"), [L, O] = gl.useState(), p = gl.useMemo(() => o.filter((A) => D === "all" || D === "models" || Du(A) === D), [o, D]), C = p.find((A) => A.id === L) ?? p[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "CAPABILITY CATALOG", title: "Capabilities", description: "从“Forge 能做什么”查看扩展、服务、执行能力和模型，而不是浏览 MCP tool 清单。", refreshedAt: m.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ c.jsx("div", { className: "toolbar", children: /* @__PURE__ */ c.jsx(_f, { value: D, onChange: V, items: [{ id: "all", label: "All", count: o.length }, { id: "extensions", label: "Extensions", count: o.filter((A) => Du(A) === "extensions").length }, { id: "services", label: "Services", count: o.filter((A) => Du(A) === "services").length }, { id: "execution", label: "Execution", count: o.filter((A) => Du(A) === "execution").length }, { id: "models", label: "Models", count: M.length }] }) }),
    D === "models" ? /* @__PURE__ */ c.jsx("div", { className: "single-list", children: /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: M.map((A) => /* @__PURE__ */ c.jsxs("div", { className: "scan-row static", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
        /* @__PURE__ */ c.jsx("strong", { children: A.displayName }),
        /* @__PURE__ */ c.jsx("p", { children: zt(A.explanation ?? A.summary, 110) })
      ] }),
      /* @__PURE__ */ c.jsx(Ll, { label: A.statusLabel ?? A.status ?? "Unknown", tone: A.status })
    ] }, A.providerId)) }) }) : /* @__PURE__ */ c.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: p.map((A) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row ${C?.id === A.id ? "selected" : ""}`, onClick: () => O(A.id), children: [
        /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ c.jsx("span", { className: "row-eyebrow", children: Du(A).toUpperCase() }),
          /* @__PURE__ */ c.jsx("strong", { children: A.name }),
          /* @__PURE__ */ c.jsx("p", { children: zt(A.description, 100) })
        ] }),
        /* @__PURE__ */ c.jsx(Ll, { label: A.statusLabel ?? A.status ?? "Unknown", tone: A.status ?? A.tone })
      ] }, A.id)) }),
      /* @__PURE__ */ c.jsx(ti, { title: C?.name, subtitle: C?.description, children: C && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Cu, { items: [["Status", /* @__PURE__ */ c.jsx(Ll, { label: C.statusLabel ?? C.status ?? "Unknown", tone: C.status ?? C.tone })], ["Provider", C.provider ?? "—"], ["Health", C.healthLabel ?? "—"], ["Lifecycle", C.lifecycleLabel ?? "—"]] }),
        C.nextStep && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Next step" }),
          /* @__PURE__ */ c.jsx("p", { children: C.nextStep })
        ] }),
        (C.capabilityLabels ?? []).length > 0 && /* @__PURE__ */ c.jsx("div", { className: "capability-lines", children: C.capabilityLabels.map((A) => /* @__PURE__ */ c.jsx("span", { children: A }, A)) }),
        (C.warnings ?? []).map((A) => /* @__PURE__ */ c.jsx("div", { className: "detail-callout warning", children: A }, A)),
        /* @__PURE__ */ c.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced · actions & protocol" }),
          /* @__PURE__ */ c.jsx("pre", { children: li({ actions: C.actions, advanced: C.advanced }) })
        ] })
      ] }) })
    ] })
  ] });
}
function $v({ value: m, onChange: x, placeholder: _ = "Search…" }) {
  return /* @__PURE__ */ c.jsxs("label", { className: "search-field", children: [
    /* @__PURE__ */ c.jsx(Hv, {}),
    /* @__PURE__ */ c.jsx("input", { value: m, onChange: (o) => x(o.target.value), placeholder: _ })
  ] });
}
function Wv({ data: m, busy: x, onRefresh: _, onRegister: o, onRemove: M }) {
  const D = m.commandCenter.repositories ?? [], [V, L] = gl.useState(""), [O, p] = gl.useState(), [C, A] = gl.useState(""), [N, G] = gl.useState(""), [jl, Al] = gl.useState(!1), Rl = gl.useMemo(() => D.filter((K) => `${K.name} ${K.path} ${K.branchLabel}`.toLowerCase().includes(V.toLowerCase())), [D, V]), q = Rl.find((K) => K.id === O) ?? Rl[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "CONTROLLER REGISTRY", title: "Repositories", description: "查看和管理 Forge 的持久化仓库边界；临时目录不需要出现在这里。", refreshedAt: m.generatedAt, busy: x, onRefresh: _, actions: /* @__PURE__ */ c.jsx(Ne, { onClick: () => Al((K) => !K), "aria-expanded": jl, children: jl ? "Cancel" : "Add repository" }) }),
    /* @__PURE__ */ c.jsxs("div", { className: "repository-tools", children: [
      /* @__PURE__ */ c.jsx($v, { value: V, onChange: L, placeholder: "Search repositories…" }),
      /* @__PURE__ */ c.jsx("span", { className: "repository-count", children: Rl.length === D.length ? `${D.length} registered` : `${Rl.length} of ${D.length}` })
    ] }),
    jl && /* @__PURE__ */ c.jsxs("form", { className: "repository-add-panel", onSubmit: (K) => {
      K.preventDefault(), C.trim() && o(C.trim(), N.trim() || void 0).then(() => {
        A(""), G(""), Al(!1);
      });
    }, children: [
      /* @__PURE__ */ c.jsxs("div", { className: "repository-add-fields", children: [
        /* @__PURE__ */ c.jsxs("label", { children: [
          /* @__PURE__ */ c.jsx("span", { children: "Local path" }),
          /* @__PURE__ */ c.jsx("input", { autoFocus: !0, value: C, onChange: (K) => A(K.target.value), placeholder: "/absolute/path" })
        ] }),
        /* @__PURE__ */ c.jsxs("label", { children: [
          /* @__PURE__ */ c.jsx("span", { children: "Display name" }),
          /* @__PURE__ */ c.jsx("input", { value: N, onChange: (K) => G(K.target.value), placeholder: "Optional" })
        ] }),
        /* @__PURE__ */ c.jsx(Ne, { type: "submit", disabled: x || !C.trim(), children: "Register" })
      ] }),
      /* @__PURE__ */ c.jsx("p", { children: "只为需要持久化 Work、缓存、并发隔离或发布治理的仓库建立注册项。" })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "split-workspace repository-workspace", children: [
      /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: Rl.map((K) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row ${q?.id === K.id ? "selected" : ""}`, onClick: () => p(K.id), children: [
        /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ c.jsx("strong", { children: K.name }),
          /* @__PURE__ */ c.jsx("p", { children: zt(K.path, 100) })
        ] }),
        /* @__PURE__ */ c.jsxs("div", { className: "scan-meta", children: [
          /* @__PURE__ */ c.jsx(Ll, { label: K.readinessLabel ?? K.statusLabel ?? "Registered", tone: K.readinessLabel ?? K.statusLabel }),
          /* @__PURE__ */ c.jsx("span", { children: K.branchLabel ?? "—" })
        ] })
      ] }, K.id)) }),
      /* @__PURE__ */ c.jsx(ti, { title: q?.name, subtitle: q?.path, children: q && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Cu, { items: [["Repository id", /* @__PURE__ */ c.jsx("code", { children: q.id })], ["Branch", q.branchLabel ?? "—"], ["Working tree", q.dirtyLabel ?? "—"], ["Readiness", /* @__PURE__ */ c.jsx(Ll, { label: q.readinessLabel ?? q.statusLabel ?? "Registered", tone: q.readinessLabel ?? q.statusLabel })]] }),
        /* @__PURE__ */ c.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced registry metadata" }),
          /* @__PURE__ */ c.jsx("pre", { children: li(q.advanced) })
        ] }),
        /* @__PURE__ */ c.jsx("div", { className: "detail-button-row", children: /* @__PURE__ */ c.jsx(Ne, { className: "danger-text", disabled: x, onClick: () => {
          M(q.id);
        }, children: "Remove registry entry" }) })
      ] }) })
    ] })
  ] });
}
function kv({ data: m, busy: x, onRefresh: _, onProviderAction: o, onProviderHealth: M, onToolAction: D, onToolHealth: V }) {
  const L = m.automationSettings;
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "LONG-LIVED CONFIG", title: "Settings", description: "模型、Provider 与本地工具的长期默认配置。Automation 调度不在这里。", refreshedAt: m.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ c.jsxs("div", { className: "settings-column", children: [
      (L.warnings ?? []).map((O) => /* @__PURE__ */ c.jsx("div", { className: "detail-callout warning", children: O }, O)),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx(Uu, { title: "Models & routing", meta: `${L.providers?.length ?? 0} providers` }),
        /* @__PURE__ */ c.jsx("div", { className: "settings-list", children: (L.providers ?? []).map((O) => /* @__PURE__ */ c.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("strong", { children: O.displayName }),
            /* @__PURE__ */ c.jsx("p", { children: zt(O.explanation ?? O.summary, 120) })
          ] }),
          /* @__PURE__ */ c.jsx(Ll, { label: O.statusLabel ?? O.status ?? "Unknown", tone: O.status }),
          /* @__PURE__ */ c.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ c.jsx(Ne, { disabled: x, onClick: () => {
              M(O);
            }, children: "Check" }),
            /* @__PURE__ */ c.jsx(Ne, { disabled: x, onClick: () => {
              o(O, O.enabled === !1 ? "enable" : "disable");
            }, children: O.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, O.providerId)) })
      ] }),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx(Uu, { title: "Local tools", meta: `${L.localTools?.length ?? 0} configured` }),
        /* @__PURE__ */ c.jsx("div", { className: "settings-list", children: (L.localTools ?? []).map((O) => /* @__PURE__ */ c.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("strong", { children: O.displayName }),
            /* @__PURE__ */ c.jsx("p", { children: zt(O.summary, 120) })
          ] }),
          /* @__PURE__ */ c.jsx(Ll, { label: O.status ?? (O.enabled === !1 ? "Disabled" : "Configured"), tone: O.status }),
          /* @__PURE__ */ c.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ c.jsx(Ne, { disabled: x, onClick: () => {
              V(O);
            }, children: "Check" }),
            /* @__PURE__ */ c.jsx(Ne, { disabled: x, onClick: () => {
              D(O, O.enabled === !1 ? "enable" : "disable");
            }, children: O.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, O.toolId)) })
      ] }),
      /* @__PURE__ */ c.jsxs("details", { className: "advanced", children: [
        /* @__PURE__ */ c.jsx("summary", { children: "Advanced routing & credentials metadata" }),
        /* @__PURE__ */ c.jsx("pre", { children: li({ routing: L.routing, credentials: L.credentials, overview: L.overview }) })
      ] })
    ] })
  ] });
}
function Fv({ data: m, busy: x, onRefresh: _ }) {
  const [o, M] = gl.useState(), D = m.commandCenter.readiness ?? {};
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "MAINTENANCE", title: "System", description: "低频工程维护入口。正常使用 Forge 不需要理解这里的运行时细节。", refreshedAt: m.generatedAt, busy: x, onRefresh: _ }),
    /* @__PURE__ */ c.jsxs("div", { className: "system-layout", children: [
      /* @__PURE__ */ c.jsxs("section", { className: "system-summary", children: [
        /* @__PURE__ */ c.jsxs("div", { className: "system-posture", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("span", { className: "eyebrow", children: "SYSTEM POSTURE" }),
            /* @__PURE__ */ c.jsx("h2", { children: Ra(D.label ?? D.headline, "Controller state") }),
            /* @__PURE__ */ c.jsx("p", { children: Ra(D.explanation ?? D.summary, "Controller and connector status") })
          ] }),
          /* @__PURE__ */ c.jsx(Ll, { label: Ra(D.state, "Unknown"), tone: Ra(D.state) })
        ] }),
        /* @__PURE__ */ c.jsx(Cu, { items: [["Controller", Ra(D.label ?? D.headline, "—")], ["Connector", Ra(m.connector?.status, "—")], ["Repositories", String(m.commandCenter.repositories?.length ?? 0)], ["Plugins", String(m.commandCenter.plugins?.length ?? 0)]] })
      ] }),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx("button", { className: "text-button", onClick: () => {
          et.advanced().then(M);
        }, children: "Load advanced diagnostics" }),
        o && /* @__PURE__ */ c.jsxs("details", { className: "advanced", open: !0, children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced diagnostics" }),
          /* @__PURE__ */ c.jsx("pre", { children: li(o) })
        ] })
      ] })
    ] })
  ] });
}
async function Zr() {
  const [m, x, _, o, M, D] = await Promise.all([et.commandCenter(), et.work(), et.workPortfolio(), et.automations(), et.automationSettings(), et.connector().catch(() => {
  })]);
  return { commandCenter: m, work: x, workPortfolio: _, automations: o, automationSettings: M, connector: D, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function Iv() {
  const [m, x] = gl.useState(Lr()), [_, o] = gl.useState(), [M, D] = gl.useState(!1), [V, L] = gl.useState(""), O = gl.useCallback(async () => {
    D(!0), L("");
    try {
      o(await Zr());
    } catch (N) {
      L(N instanceof Error ? N.message : String(N));
    } finally {
      D(!1);
    }
  }, []);
  gl.useEffect(() => {
    O();
    const N = () => x(Lr());
    return addEventListener("hashchange", N), () => removeEventListener("hashchange", N);
  }, [O]);
  const p = gl.useCallback(async (N) => {
    D(!0);
    try {
      await N(), o(await Zr());
    } catch (G) {
      L(G instanceof Error ? G.message : String(G));
    } finally {
      D(!1);
    }
  }, []);
  if (!_) return /* @__PURE__ */ c.jsxs("div", { className: "boot-state", children: [
    /* @__PURE__ */ c.jsx("span", { className: "brand-mark", children: "F" }),
    /* @__PURE__ */ c.jsx("strong", { children: V ? "Forge console unavailable" : "Loading Forge…" }),
    V && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
      /* @__PURE__ */ c.jsx("p", { children: V }),
      /* @__PURE__ */ c.jsx("button", { className: "button", onClick: () => {
        O();
      }, children: "Retry" })
    ] })
  ] });
  const C = { data: _, busy: M, onRefresh: () => {
    O();
  } };
  let A;
  switch (m) {
    case "automations":
      A = /* @__PURE__ */ c.jsx(Vv, { ...C, onAction: (N, G) => p(() => et.automationAction(N.source, N.repoId, N.id, G)) });
      break;
    case "work":
      A = /* @__PURE__ */ c.jsx(Jv, { ...C });
      break;
    case "capabilities":
      A = /* @__PURE__ */ c.jsx(wv, { ...C });
      break;
    case "repositories":
      A = /* @__PURE__ */ c.jsx(Wv, { ...C, onRegister: (N, G) => p(() => et.registerRepository(N, G)), onRemove: (N) => p(() => et.removeRepository(N)) });
      break;
    case "settings":
      A = /* @__PURE__ */ c.jsx(kv, { ...C, onProviderAction: (N, G) => p(() => et.providerAction(N.providerId, G)), onProviderHealth: (N) => p(() => et.providerHealth(N.providerId)), onToolAction: (N, G) => p(() => et.localToolAction(N.toolId, G)), onToolHealth: (N) => p(() => et.localToolHealth(N.toolId)) });
      break;
    case "system":
      A = /* @__PURE__ */ c.jsx(Fv, { ...C });
      break;
    default:
      A = /* @__PURE__ */ c.jsx(Zv, { ...C });
  }
  return /* @__PURE__ */ c.jsxs(Gv, { route: m, children: [
    V && /* @__PURE__ */ c.jsxs("div", { className: "global-error", children: [
      /* @__PURE__ */ c.jsx("strong", { children: "Last action failed" }),
      /* @__PURE__ */ c.jsx("span", { children: V }),
      /* @__PURE__ */ c.jsx("button", { onClick: () => L(""), children: "×" })
    ] }),
    A
  ] });
}
const Jr = document.getElementById("app");
if (!Jr) throw new Error("Forge console root missing");
xv.createRoot(Jr).render(/* @__PURE__ */ c.jsx(gl.StrictMode, { children: /* @__PURE__ */ c.jsx(Iv, {}) }));
