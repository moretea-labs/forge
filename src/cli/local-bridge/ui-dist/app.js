var pf = { exports: {} }, Ou = {};
var Dr;
function yv() {
  if (Dr) return Ou;
  Dr = 1;
  var s = /* @__PURE__ */ Symbol.for("react.transitional.element"), j = /* @__PURE__ */ Symbol.for("react.fragment");
  function _(r, H, D) {
    var L = null;
    if (D !== void 0 && (L = "" + D), H.key !== void 0 && (L = "" + H.key), "key" in H) {
      D = {};
      for (var Z in H)
        Z !== "key" && (D[Z] = H[Z]);
    } else D = H;
    return H = D.ref, {
      $$typeof: s,
      type: r,
      key: L,
      ref: H !== void 0 ? H : null,
      props: D
    };
  }
  return Ou.Fragment = j, Ou.jsx = _, Ou.jsxs = _, Ou;
}
var Ur;
function gv() {
  return Ur || (Ur = 1, pf.exports = yv()), pf.exports;
}
var c = gv(), Af = { exports: {} }, K = {};
var Rr;
function bv() {
  if (Rr) return K;
  Rr = 1;
  var s = /* @__PURE__ */ Symbol.for("react.transitional.element"), j = /* @__PURE__ */ Symbol.for("react.portal"), _ = /* @__PURE__ */ Symbol.for("react.fragment"), r = /* @__PURE__ */ Symbol.for("react.strict_mode"), H = /* @__PURE__ */ Symbol.for("react.profiler"), D = /* @__PURE__ */ Symbol.for("react.consumer"), L = /* @__PURE__ */ Symbol.for("react.context"), Z = /* @__PURE__ */ Symbol.for("react.forward_ref"), N = /* @__PURE__ */ Symbol.for("react.suspense"), p = /* @__PURE__ */ Symbol.for("react.memo"), M = /* @__PURE__ */ Symbol.for("react.lazy"), b = /* @__PURE__ */ Symbol.for("react.activity"), C = Symbol.iterator;
  function O(m) {
    return m === null || typeof m != "object" ? null : (m = C && m[C] || m["@@iterator"], typeof m == "function" ? m : null);
  }
  var xl = {
    isMounted: function() {
      return !1;
    },
    enqueueForceUpdate: function() {
    },
    enqueueReplaceState: function() {
    },
    enqueueSetState: function() {
    }
  }, El = Object.assign, Nl = {};
  function cl(m, E, R) {
    this.props = m, this.context = E, this.refs = Nl, this.updater = R || xl;
  }
  cl.prototype.isReactComponent = {}, cl.prototype.setState = function(m, E) {
    if (typeof m != "object" && typeof m != "function" && m != null)
      throw Error(
        "takes an object of state variables to update or a function which returns an object of state variables."
      );
    this.updater.enqueueSetState(this, m, E, "setState");
  }, cl.prototype.forceUpdate = function(m) {
    this.updater.enqueueForceUpdate(this, m, "forceUpdate");
  };
  function tl() {
  }
  tl.prototype = cl.prototype;
  function Rl(m, E, R) {
    this.props = m, this.context = E, this.refs = Nl, this.updater = R || xl;
  }
  var Jl = Rl.prototype = new tl();
  Jl.constructor = Rl, El(Jl, cl.prototype), Jl.isPureReactComponent = !0;
  var ht = Array.isArray;
  function X() {
  }
  var $ = { H: null, A: null, T: null, S: null }, Cl = Object.prototype.hasOwnProperty;
  function wl(m, E, R) {
    var B = R.ref;
    return {
      $$typeof: s,
      type: m,
      key: E,
      ref: B !== void 0 ? B : null,
      props: R
    };
  }
  function We(m, E) {
    return wl(m.type, E, m.props);
  }
  function Mt(m) {
    return typeof m == "object" && m !== null && m.$$typeof === s;
  }
  function $l(m) {
    var E = { "=": "=0", ":": "=2" };
    return "$" + m.replace(/[=:]/g, function(R) {
      return E[R];
    });
  }
  var Ne = /\/+/g;
  function Ht(m, E) {
    return typeof m == "object" && m !== null && m.key != null ? $l("" + m.key) : E.toString(36);
  }
  function Et(m) {
    switch (m.status) {
      case "fulfilled":
        return m.value;
      case "rejected":
        throw m.reason;
      default:
        switch (typeof m.status == "string" ? m.then(X, X) : (m.status = "pending", m.then(
          function(E) {
            m.status === "pending" && (m.status = "fulfilled", m.value = E);
          },
          function(E) {
            m.status === "pending" && (m.status = "rejected", m.reason = E);
          }
        )), m.status) {
          case "fulfilled":
            return m.value;
          case "rejected":
            throw m.reason;
        }
    }
    throw m;
  }
  function z(m, E, R, B, J) {
    var k = typeof m;
    (k === "undefined" || k === "boolean") && (m = null);
    var il = !1;
    if (m === null) il = !0;
    else
      switch (k) {
        case "bigint":
        case "string":
        case "number":
          il = !0;
          break;
        case "object":
          switch (m.$$typeof) {
            case s:
            case j:
              il = !0;
              break;
            case M:
              return il = m._init, z(
                il(m._payload),
                E,
                R,
                B,
                J
              );
          }
      }
    if (il)
      return J = J(m), il = B === "" ? "." + Ht(m, 0) : B, ht(J) ? (R = "", il != null && (R = il.replace(Ne, "$&/") + "/"), z(J, E, R, "", function(Ha) {
        return Ha;
      })) : J != null && (Mt(J) && (J = We(
        J,
        R + (J.key == null || m && m.key === J.key ? "" : ("" + J.key).replace(
          Ne,
          "$&/"
        ) + "/") + il
      )), E.push(J)), 1;
    il = 0;
    var Vl = B === "" ? "." : B + ":";
    if (ht(m))
      for (var jl = 0; jl < m.length; jl++)
        B = m[jl], k = Vl + Ht(B, jl), il += z(
          B,
          E,
          R,
          k,
          J
        );
    else if (jl = O(m), typeof jl == "function")
      for (m = jl.call(m), jl = 0; !(B = m.next()).done; )
        B = B.value, k = Vl + Ht(B, jl++), il += z(
          B,
          E,
          R,
          k,
          J
        );
    else if (k === "object") {
      if (typeof m.then == "function")
        return z(
          Et(m),
          E,
          R,
          B,
          J
        );
      throw E = String(m), Error(
        "Objects are not valid as a React child (found: " + (E === "[object Object]" ? "object with keys {" + Object.keys(m).join(", ") + "}" : E) + "). If you meant to render a collection of children, use an array instead."
      );
    }
    return il;
  }
  function U(m, E, R) {
    if (m == null) return m;
    var B = [], J = 0;
    return z(m, B, "", "", function(k) {
      return E.call(R, k, J++);
    }), B;
  }
  function V(m) {
    if (m._status === -1) {
      var E = m._result;
      E = E(), E.then(
        function(R) {
          (m._status === 0 || m._status === -1) && (m._status = 1, m._result = R);
        },
        function(R) {
          (m._status === 0 || m._status === -1) && (m._status = 2, m._result = R);
        }
      ), m._status === -1 && (m._status = 0, m._result = E);
    }
    if (m._status === 1) return m._result.default;
    throw m._result;
  }
  var ol = typeof reportError == "function" ? reportError : function(m) {
    if (typeof window == "object" && typeof window.ErrorEvent == "function") {
      var E = new window.ErrorEvent("error", {
        bubbles: !0,
        cancelable: !0,
        message: typeof m == "object" && m !== null && typeof m.message == "string" ? String(m.message) : String(m),
        error: m
      });
      if (!window.dispatchEvent(E)) return;
    } else if (typeof process == "object" && typeof process.emit == "function") {
      process.emit("uncaughtException", m);
      return;
    }
    console.error(m);
  }, hl = {
    map: U,
    forEach: function(m, E, R) {
      U(
        m,
        function() {
          E.apply(this, arguments);
        },
        R
      );
    },
    count: function(m) {
      var E = 0;
      return U(m, function() {
        E++;
      }), E;
    },
    toArray: function(m) {
      return U(m, function(E) {
        return E;
      }) || [];
    },
    only: function(m) {
      if (!Mt(m))
        throw Error(
          "React.Children.only expected to receive a single React element child."
        );
      return m;
    }
  };
  return K.Activity = b, K.Children = hl, K.Component = cl, K.Fragment = _, K.Profiler = H, K.PureComponent = Rl, K.StrictMode = r, K.Suspense = N, K.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = $, K.__COMPILER_RUNTIME = {
    __proto__: null,
    c: function(m) {
      return $.H.useMemoCache(m);
    }
  }, K.cache = function(m) {
    return function() {
      return m.apply(null, arguments);
    };
  }, K.cacheSignal = function() {
    return null;
  }, K.cloneElement = function(m, E, R) {
    if (m == null)
      throw Error(
        "The argument must be a React element, but you passed " + m + "."
      );
    var B = El({}, m.props), J = m.key;
    if (E != null)
      for (k in E.key !== void 0 && (J = "" + E.key), E)
        !Cl.call(E, k) || k === "key" || k === "__self" || k === "__source" || k === "ref" && E.ref === void 0 || (B[k] = E[k]);
    var k = arguments.length - 2;
    if (k === 1) B.children = R;
    else if (1 < k) {
      for (var il = Array(k), Vl = 0; Vl < k; Vl++)
        il[Vl] = arguments[Vl + 2];
      B.children = il;
    }
    return wl(m.type, J, B);
  }, K.createContext = function(m) {
    return m = {
      $$typeof: L,
      _currentValue: m,
      _currentValue2: m,
      _threadCount: 0,
      Provider: null,
      Consumer: null
    }, m.Provider = m, m.Consumer = {
      $$typeof: D,
      _context: m
    }, m;
  }, K.createElement = function(m, E, R) {
    var B, J = {}, k = null;
    if (E != null)
      for (B in E.key !== void 0 && (k = "" + E.key), E)
        Cl.call(E, B) && B !== "key" && B !== "__self" && B !== "__source" && (J[B] = E[B]);
    var il = arguments.length - 2;
    if (il === 1) J.children = R;
    else if (1 < il) {
      for (var Vl = Array(il), jl = 0; jl < il; jl++)
        Vl[jl] = arguments[jl + 2];
      J.children = Vl;
    }
    if (m && m.defaultProps)
      for (B in il = m.defaultProps, il)
        J[B] === void 0 && (J[B] = il[B]);
    return wl(m, k, J);
  }, K.createRef = function() {
    return { current: null };
  }, K.forwardRef = function(m) {
    return { $$typeof: Z, render: m };
  }, K.isValidElement = Mt, K.lazy = function(m) {
    return {
      $$typeof: M,
      _payload: { _status: -1, _result: m },
      _init: V
    };
  }, K.memo = function(m, E) {
    return {
      $$typeof: p,
      type: m,
      compare: E === void 0 ? null : E
    };
  }, K.startTransition = function(m) {
    var E = $.T, R = {};
    $.T = R;
    try {
      var B = m(), J = $.S;
      J !== null && J(R, B), typeof B == "object" && B !== null && typeof B.then == "function" && B.then(X, ol);
    } catch (k) {
      ol(k);
    } finally {
      E !== null && R.types !== null && (E.types = R.types), $.T = E;
    }
  }, K.unstable_useCacheRefresh = function() {
    return $.H.useCacheRefresh();
  }, K.use = function(m) {
    return $.H.use(m);
  }, K.useActionState = function(m, E, R) {
    return $.H.useActionState(m, E, R);
  }, K.useCallback = function(m, E) {
    return $.H.useCallback(m, E);
  }, K.useContext = function(m) {
    return $.H.useContext(m);
  }, K.useDebugValue = function() {
  }, K.useDeferredValue = function(m, E) {
    return $.H.useDeferredValue(m, E);
  }, K.useEffect = function(m, E) {
    return $.H.useEffect(m, E);
  }, K.useEffectEvent = function(m) {
    return $.H.useEffectEvent(m);
  }, K.useId = function() {
    return $.H.useId();
  }, K.useImperativeHandle = function(m, E, R) {
    return $.H.useImperativeHandle(m, E, R);
  }, K.useInsertionEffect = function(m, E) {
    return $.H.useInsertionEffect(m, E);
  }, K.useLayoutEffect = function(m, E) {
    return $.H.useLayoutEffect(m, E);
  }, K.useMemo = function(m, E) {
    return $.H.useMemo(m, E);
  }, K.useOptimistic = function(m, E) {
    return $.H.useOptimistic(m, E);
  }, K.useReducer = function(m, E, R) {
    return $.H.useReducer(m, E, R);
  }, K.useRef = function(m) {
    return $.H.useRef(m);
  }, K.useState = function(m) {
    return $.H.useState(m);
  }, K.useSyncExternalStore = function(m, E, R) {
    return $.H.useSyncExternalStore(
      m,
      E,
      R
    );
  }, K.useTransition = function() {
    return $.H.useTransition();
  }, K.version = "19.2.8", K;
}
var Cr;
function Nf() {
  return Cr || (Cr = 1, Af.exports = bv()), Af.exports;
}
var bl = Nf(), jf = { exports: {} }, _u = {}, zf = { exports: {} }, Tf = {};
var Hr;
function Sv() {
  return Hr || (Hr = 1, (function(s) {
    function j(z, U) {
      var V = z.length;
      z.push(U);
      l: for (; 0 < V; ) {
        var ol = V - 1 >>> 1, hl = z[ol];
        if (0 < H(hl, U))
          z[ol] = U, z[V] = hl, V = ol;
        else break l;
      }
    }
    function _(z) {
      return z.length === 0 ? null : z[0];
    }
    function r(z) {
      if (z.length === 0) return null;
      var U = z[0], V = z.pop();
      if (V !== U) {
        z[0] = V;
        l: for (var ol = 0, hl = z.length, m = hl >>> 1; ol < m; ) {
          var E = 2 * (ol + 1) - 1, R = z[E], B = E + 1, J = z[B];
          if (0 > H(R, V))
            B < hl && 0 > H(J, R) ? (z[ol] = J, z[B] = V, ol = B) : (z[ol] = R, z[E] = V, ol = E);
          else if (B < hl && 0 > H(J, V))
            z[ol] = J, z[B] = V, ol = B;
          else break l;
        }
      }
      return U;
    }
    function H(z, U) {
      var V = z.sortIndex - U.sortIndex;
      return V !== 0 ? V : z.id - U.id;
    }
    if (s.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
      var D = performance;
      s.unstable_now = function() {
        return D.now();
      };
    } else {
      var L = Date, Z = L.now();
      s.unstable_now = function() {
        return L.now() - Z;
      };
    }
    var N = [], p = [], M = 1, b = null, C = 3, O = !1, xl = !1, El = !1, Nl = !1, cl = typeof setTimeout == "function" ? setTimeout : null, tl = typeof clearTimeout == "function" ? clearTimeout : null, Rl = typeof setImmediate < "u" ? setImmediate : null;
    function Jl(z) {
      for (var U = _(p); U !== null; ) {
        if (U.callback === null) r(p);
        else if (U.startTime <= z)
          r(p), U.sortIndex = U.expirationTime, j(N, U);
        else break;
        U = _(p);
      }
    }
    function ht(z) {
      if (El = !1, Jl(z), !xl)
        if (_(N) !== null)
          xl = !0, X || (X = !0, $l());
        else {
          var U = _(p);
          U !== null && Et(ht, U.startTime - z);
        }
    }
    var X = !1, $ = -1, Cl = 5, wl = -1;
    function We() {
      return Nl ? !0 : !(s.unstable_now() - wl < Cl);
    }
    function Mt() {
      if (Nl = !1, X) {
        var z = s.unstable_now();
        wl = z;
        var U = !0;
        try {
          l: {
            xl = !1, El && (El = !1, tl($), $ = -1), O = !0;
            var V = C;
            try {
              t: {
                for (Jl(z), b = _(N); b !== null && !(b.expirationTime > z && We()); ) {
                  var ol = b.callback;
                  if (typeof ol == "function") {
                    b.callback = null, C = b.priorityLevel;
                    var hl = ol(
                      b.expirationTime <= z
                    );
                    if (z = s.unstable_now(), typeof hl == "function") {
                      b.callback = hl, Jl(z), U = !0;
                      break t;
                    }
                    b === _(N) && r(N), Jl(z);
                  } else r(N);
                  b = _(N);
                }
                if (b !== null) U = !0;
                else {
                  var m = _(p);
                  m !== null && Et(
                    ht,
                    m.startTime - z
                  ), U = !1;
                }
              }
              break l;
            } finally {
              b = null, C = V, O = !1;
            }
            U = void 0;
          }
        } finally {
          U ? $l() : X = !1;
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
    function Et(z, U) {
      $ = cl(function() {
        z(s.unstable_now());
      }, U);
    }
    s.unstable_IdlePriority = 5, s.unstable_ImmediatePriority = 1, s.unstable_LowPriority = 4, s.unstable_NormalPriority = 3, s.unstable_Profiling = null, s.unstable_UserBlockingPriority = 2, s.unstable_cancelCallback = function(z) {
      z.callback = null;
    }, s.unstable_forceFrameRate = function(z) {
      0 > z || 125 < z ? console.error(
        "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
      ) : Cl = 0 < z ? Math.floor(1e3 / z) : 5;
    }, s.unstable_getCurrentPriorityLevel = function() {
      return C;
    }, s.unstable_next = function(z) {
      switch (C) {
        case 1:
        case 2:
        case 3:
          var U = 3;
          break;
        default:
          U = C;
      }
      var V = C;
      C = U;
      try {
        return z();
      } finally {
        C = V;
      }
    }, s.unstable_requestPaint = function() {
      Nl = !0;
    }, s.unstable_runWithPriority = function(z, U) {
      switch (z) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
          break;
        default:
          z = 3;
      }
      var V = C;
      C = z;
      try {
        return U();
      } finally {
        C = V;
      }
    }, s.unstable_scheduleCallback = function(z, U, V) {
      var ol = s.unstable_now();
      switch (typeof V == "object" && V !== null ? (V = V.delay, V = typeof V == "number" && 0 < V ? ol + V : ol) : V = ol, z) {
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
      return hl = V + hl, z = {
        id: M++,
        callback: U,
        priorityLevel: z,
        startTime: V,
        expirationTime: hl,
        sortIndex: -1
      }, V > ol ? (z.sortIndex = V, j(p, z), _(N) === null && z === _(p) && (El ? (tl($), $ = -1) : El = !0, Et(ht, V - ol))) : (z.sortIndex = hl, j(N, z), xl || O || (xl = !0, X || (X = !0, $l()))), z;
    }, s.unstable_shouldYield = We, s.unstable_wrapCallback = function(z) {
      var U = C;
      return function() {
        var V = C;
        C = U;
        try {
          return z.apply(this, arguments);
        } finally {
          C = V;
        }
      };
    };
  })(Tf)), Tf;
}
var qr;
function pv() {
  return qr || (qr = 1, zf.exports = Sv()), zf.exports;
}
var xf = { exports: {} }, Xl = {};
var Br;
function Av() {
  if (Br) return Xl;
  Br = 1;
  var s = Nf();
  function j(N) {
    var p = "https://react.dev/errors/" + N;
    if (1 < arguments.length) {
      p += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var M = 2; M < arguments.length; M++)
        p += "&args[]=" + encodeURIComponent(arguments[M]);
    }
    return "Minified React error #" + N + "; visit " + p + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function _() {
  }
  var r = {
    d: {
      f: _,
      r: function() {
        throw Error(j(522));
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
  }, H = /* @__PURE__ */ Symbol.for("react.portal");
  function D(N, p, M) {
    var b = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: H,
      key: b == null ? null : "" + b,
      children: N,
      containerInfo: p,
      implementation: M
    };
  }
  var L = s.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function Z(N, p) {
    if (N === "font") return "";
    if (typeof p == "string")
      return p === "use-credentials" ? p : "";
  }
  return Xl.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = r, Xl.createPortal = function(N, p) {
    var M = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!p || p.nodeType !== 1 && p.nodeType !== 9 && p.nodeType !== 11)
      throw Error(j(299));
    return D(N, p, null, M);
  }, Xl.flushSync = function(N) {
    var p = L.T, M = r.p;
    try {
      if (L.T = null, r.p = 2, N) return N();
    } finally {
      L.T = p, r.p = M, r.d.f();
    }
  }, Xl.preconnect = function(N, p) {
    typeof N == "string" && (p ? (p = p.crossOrigin, p = typeof p == "string" ? p === "use-credentials" ? p : "" : void 0) : p = null, r.d.C(N, p));
  }, Xl.prefetchDNS = function(N) {
    typeof N == "string" && r.d.D(N);
  }, Xl.preinit = function(N, p) {
    if (typeof N == "string" && p && typeof p.as == "string") {
      var M = p.as, b = Z(M, p.crossOrigin), C = typeof p.integrity == "string" ? p.integrity : void 0, O = typeof p.fetchPriority == "string" ? p.fetchPriority : void 0;
      M === "style" ? r.d.S(
        N,
        typeof p.precedence == "string" ? p.precedence : void 0,
        {
          crossOrigin: b,
          integrity: C,
          fetchPriority: O
        }
      ) : M === "script" && r.d.X(N, {
        crossOrigin: b,
        integrity: C,
        fetchPriority: O,
        nonce: typeof p.nonce == "string" ? p.nonce : void 0
      });
    }
  }, Xl.preinitModule = function(N, p) {
    if (typeof N == "string")
      if (typeof p == "object" && p !== null) {
        if (p.as == null || p.as === "script") {
          var M = Z(
            p.as,
            p.crossOrigin
          );
          r.d.M(N, {
            crossOrigin: M,
            integrity: typeof p.integrity == "string" ? p.integrity : void 0,
            nonce: typeof p.nonce == "string" ? p.nonce : void 0
          });
        }
      } else p == null && r.d.M(N);
  }, Xl.preload = function(N, p) {
    if (typeof N == "string" && typeof p == "object" && p !== null && typeof p.as == "string") {
      var M = p.as, b = Z(M, p.crossOrigin);
      r.d.L(N, M, {
        crossOrigin: b,
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
  }, Xl.preloadModule = function(N, p) {
    if (typeof N == "string")
      if (p) {
        var M = Z(p.as, p.crossOrigin);
        r.d.m(N, {
          as: typeof p.as == "string" && p.as !== "script" ? p.as : void 0,
          crossOrigin: M,
          integrity: typeof p.integrity == "string" ? p.integrity : void 0
        });
      } else r.d.m(N);
  }, Xl.requestFormReset = function(N) {
    r.d.r(N);
  }, Xl.unstable_batchedUpdates = function(N, p) {
    return N(p);
  }, Xl.useFormState = function(N, p, M) {
    return L.H.useFormState(N, p, M);
  }, Xl.useFormStatus = function() {
    return L.H.useHostTransitionStatus();
  }, Xl.version = "19.2.8", Xl;
}
var Yr;
function jv() {
  if (Yr) return xf.exports;
  Yr = 1;
  function s() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(s);
      } catch (j) {
        console.error(j);
      }
  }
  return s(), xf.exports = Av(), xf.exports;
}
var Gr;
function zv() {
  if (Gr) return _u;
  Gr = 1;
  var s = pv(), j = Nf(), _ = jv();
  function r(l) {
    var t = "https://react.dev/errors/" + l;
    if (1 < arguments.length) {
      t += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var e = 2; e < arguments.length; e++)
        t += "&args[]=" + encodeURIComponent(arguments[e]);
    }
    return "Minified React error #" + l + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function H(l) {
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
  function L(l) {
    if (l.tag === 13) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function Z(l) {
    if (l.tag === 31) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function N(l) {
    if (D(l) !== l)
      throw Error(r(188));
  }
  function p(l) {
    var t = l.alternate;
    if (!t) {
      if (t = D(l), t === null) throw Error(r(188));
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
          if (n === e) return N(u), l;
          if (n === a) return N(u), t;
          n = n.sibling;
        }
        throw Error(r(188));
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
          if (!i) throw Error(r(189));
        }
      }
      if (e.alternate !== a) throw Error(r(190));
    }
    if (e.tag !== 3) throw Error(r(188));
    return e.stateNode.current === e ? l : t;
  }
  function M(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l;
    for (l = l.child; l !== null; ) {
      if (t = M(l), t !== null) return t;
      l = l.sibling;
    }
    return null;
  }
  var b = Object.assign, C = /* @__PURE__ */ Symbol.for("react.element"), O = /* @__PURE__ */ Symbol.for("react.transitional.element"), xl = /* @__PURE__ */ Symbol.for("react.portal"), El = /* @__PURE__ */ Symbol.for("react.fragment"), Nl = /* @__PURE__ */ Symbol.for("react.strict_mode"), cl = /* @__PURE__ */ Symbol.for("react.profiler"), tl = /* @__PURE__ */ Symbol.for("react.consumer"), Rl = /* @__PURE__ */ Symbol.for("react.context"), Jl = /* @__PURE__ */ Symbol.for("react.forward_ref"), ht = /* @__PURE__ */ Symbol.for("react.suspense"), X = /* @__PURE__ */ Symbol.for("react.suspense_list"), $ = /* @__PURE__ */ Symbol.for("react.memo"), Cl = /* @__PURE__ */ Symbol.for("react.lazy"), wl = /* @__PURE__ */ Symbol.for("react.activity"), We = /* @__PURE__ */ Symbol.for("react.memo_cache_sentinel"), Mt = Symbol.iterator;
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
      case El:
        return "Fragment";
      case cl:
        return "Profiler";
      case Nl:
        return "StrictMode";
      case ht:
        return "Suspense";
      case X:
        return "SuspenseList";
      case wl:
        return "Activity";
    }
    if (typeof l == "object")
      switch (l.$$typeof) {
        case xl:
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
  var Et = Array.isArray, z = j.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, U = _.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, V = {
    pending: !1,
    data: null,
    method: null,
    action: null
  }, ol = [], hl = -1;
  function m(l) {
    return { current: l };
  }
  function E(l) {
    0 > hl || (l.current = ol[hl], ol[hl] = null, hl--);
  }
  function R(l, t) {
    hl++, ol[hl] = l.current, l.current = t;
  }
  var B = m(null), J = m(null), k = m(null), il = m(null);
  function Vl(l, t) {
    switch (R(k, t), R(J, l), R(B, null), t.nodeType) {
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
    E(B), R(B, l);
  }
  function jl() {
    E(B), E(J), E(k);
  }
  function Ha(l) {
    l.memoizedState !== null && R(il, l);
    var t = B.current, e = tr(t, l.type);
    t !== e && (R(J, l), R(B, e));
  }
  function Uu(l) {
    J.current === l && (E(B), E(J)), il.current === l && (E(il), Tu._currentValue = V);
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
              var x = function() {
                throw Error();
              };
              if (Object.defineProperty(x.prototype, "props", {
                set: function() {
                  throw Error();
                }
              }), typeof Reflect == "object" && Reflect.construct) {
                try {
                  Reflect.construct(x, []);
                } catch (S) {
                  var g = S;
                }
                Reflect.construct(l, [], x);
              } else {
                try {
                  x.call();
                } catch (S) {
                  g = S;
                }
                l.call(x.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (S) {
                g = S;
              }
              (x = l()) && typeof x.catch == "function" && x.catch(function() {
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
        var o = i.split(`
`), y = f.split(`
`);
        for (u = a = 0; a < o.length && !o[a].includes("DetermineComponentFrameRoot"); )
          a++;
        for (; u < y.length && !y[u].includes(
          "DetermineComponentFrameRoot"
        ); )
          u++;
        if (a === o.length || u === y.length)
          for (a = o.length - 1, u = y.length - 1; 1 <= a && 0 <= u && o[a] !== y[u]; )
            u--;
        for (; 1 <= a && 0 <= u; a--, u--)
          if (o[a] !== y[u]) {
            if (a !== 1 || u !== 1)
              do
                if (a--, u--, 0 > u || o[a] !== y[u]) {
                  var A = `
` + o[a].replace(" at new ", " at ");
                  return l.displayName && A.includes("<anonymous>") && (A = A.replace("<anonymous>", l.displayName)), A;
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
  function wr(l, t) {
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
        t += wr(l, e), e = l, l = l.return;
      while (l);
      return t;
    } catch (a) {
      return `
Error generating stack: ` + a.message + `
` + a.stack;
    }
  }
  var ui = Object.prototype.hasOwnProperty, ni = s.unstable_scheduleCallback, ii = s.unstable_cancelCallback, $r = s.unstable_shouldYield, Wr = s.unstable_requestPaint, ut = s.unstable_now, kr = s.unstable_getCurrentPriorityLevel, Df = s.unstable_ImmediatePriority, Uf = s.unstable_UserBlockingPriority, Ru = s.unstable_NormalPriority, Fr = s.unstable_LowPriority, Rf = s.unstable_IdlePriority, Ir = s.log, Pr = s.unstable_setDisableYieldValue, qa = null, nt = null;
  function te(l) {
    if (typeof Ir == "function" && Pr(l), nt && typeof nt.setStrictMode == "function")
      try {
        nt.setStrictMode(qa, l);
      } catch {
      }
  }
  var it = Math.clz32 ? Math.clz32 : em, lm = Math.log, tm = Math.LN2;
  function em(l) {
    return l >>>= 0, l === 0 ? 32 : 31 - (lm(l) / tm | 0) | 0;
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
    var f = a & 134217727;
    return f !== 0 ? (a = f & ~n, a !== 0 ? u = _e(a) : (i &= f, i !== 0 ? u = _e(i) : e || (e = f & ~l, e !== 0 && (u = _e(e))))) : (f = a & ~n, f !== 0 ? u = _e(f) : i !== 0 ? u = _e(i) : e || (e = a & ~l, e !== 0 && (u = _e(e)))), u === 0 ? 0 : t !== 0 && t !== u && (t & n) === 0 && (n = u & -u, e = t & -t, n >= e || n === 32 && (e & 4194048) !== 0) ? t : u;
  }
  function Ba(l, t) {
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
  function um(l, t, e, a, u, n) {
    var i = l.pendingLanes;
    l.pendingLanes = e, l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0, l.expiredLanes &= e, l.entangledLanes &= e, l.errorRecoveryDisabledLanes &= e, l.shellSuspendCounter = 0;
    var f = l.entanglements, o = l.expirationTimes, y = l.hiddenUpdates;
    for (e = i & ~e; 0 < e; ) {
      var A = 31 - it(e), x = 1 << A;
      f[A] = 0, o[A] = -1;
      var g = y[A];
      if (g !== null)
        for (y[A] = null, A = 0; A < g.length; A++) {
          var S = g[A];
          S !== null && (S.lane &= -536870913);
        }
      e &= ~x;
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
    return l !== 0 ? l : (l = window.event, l === void 0 ? 32 : Tr(l.type));
  }
  function Gf(l, t) {
    var e = U.p;
    try {
      return U.p = l, t();
    } finally {
      U.p = e;
    }
  }
  var ee = Math.random().toString(36).slice(2), Bl = "__reactFiber$" + ee, Wl = "__reactProps$" + ee, ke = "__reactContainer$" + ee, oi = "__reactEvents$" + ee, nm = "__reactListeners$" + ee, im = "__reactHandles$" + ee, Lf = "__reactResources$" + ee, Ga = "__reactMarker$" + ee;
  function di(l) {
    delete l[Bl], delete l[Wl], delete l[oi], delete l[nm], delete l[im];
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
    throw Error(r(33));
  }
  function Pe(l) {
    var t = l[Lf];
    return t || (t = l[Lf] = { hoistableStyles: /* @__PURE__ */ new Map(), hoistableScripts: /* @__PURE__ */ new Map() }), t;
  }
  function Hl(l) {
    l[Ga] = !0;
  }
  var Qf = /* @__PURE__ */ new Set(), Xf = {};
  function Me(l, t) {
    la(l, t), la(l + "Capture", t);
  }
  function la(l, t) {
    for (Xf[l] = t, l = 0; l < t.length; l++)
      Qf.add(t[l]);
  }
  var cm = RegExp(
    "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"
  ), Zf = {}, Vf = {};
  function fm(l) {
    return ui.call(Vf, l) ? !0 : ui.call(Zf, l) ? !1 : cm.test(l) ? Vf[l] = !0 : (Zf[l] = !0, !1);
  }
  function Yu(l, t, e) {
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
  function ri(l) {
    if (!l._valueTracker) {
      var t = Kf(l) ? "checked" : "value";
      l._valueTracker = sm(
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
  var om = /[\n"\\]/g;
  function yt(l) {
    return l.replace(
      om,
      function(t) {
        return "\\" + t.charCodeAt(0).toString(16) + " ";
      }
    );
  }
  function mi(l, t, e, a, u, n, i, f) {
    l.name = "", i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" ? l.type = i : l.removeAttribute("type"), t != null ? i === "number" ? (t === 0 && l.value === "" || l.value != t) && (l.value = "" + vt(t)) : l.value !== "" + vt(t) && (l.value = "" + vt(t)) : i !== "submit" && i !== "reset" || l.removeAttribute("value"), t != null ? hi(l, i, vt(t)) : e != null ? hi(l, i, vt(e)) : a != null && l.removeAttribute("value"), u == null && n != null && (l.defaultChecked = !!n), u != null && (l.checked = u && typeof u != "function" && typeof u != "symbol"), f != null && typeof f != "function" && typeof f != "symbol" && typeof f != "boolean" ? l.name = "" + vt(f) : l.removeAttribute("name");
  }
  function wf(l, t, e, a, u, n, i, f) {
    if (n != null && typeof n != "function" && typeof n != "symbol" && typeof n != "boolean" && (l.type = n), t != null || e != null) {
      if (!(n !== "submit" && n !== "reset" || t != null)) {
        ri(l);
        return;
      }
      e = e != null ? "" + vt(e) : "", t = t != null ? "" + vt(t) : e, f || t === l.value || (l.value = t), l.defaultValue = t;
    }
    a = a ?? u, a = typeof a != "function" && typeof a != "symbol" && !!a, l.checked = f ? l.checked : !!a, l.defaultChecked = !!a, i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" && (l.name = i), ri(l);
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
        if (e != null) throw Error(r(92));
        if (Et(a)) {
          if (1 < a.length) throw Error(r(93));
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
  var dm = new Set(
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
      " "
    )
  );
  function kf(l, t, e) {
    var a = t.indexOf("--") === 0;
    e == null || typeof e == "boolean" || e === "" ? a ? l.setProperty(t, "") : t === "float" ? l.cssFloat = "" : l[t] = "" : a ? l.setProperty(t, e) : typeof e != "number" || e === 0 || dm.has(t) ? t === "float" ? l.cssFloat = e : l[t] = ("" + e).trim() : l[t] = e + "px";
  }
  function Ff(l, t, e) {
    if (t != null && typeof t != "object")
      throw Error(r(62));
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
  function Qu(l) {
    return mm.test("" + l) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : l;
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
                if (!u) throw Error(r(90));
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
  var bi = !1;
  function Pf(l, t, e) {
    if (bi) return l(t, e);
    bi = !0;
    try {
      var a = l(t);
      return a;
    } finally {
      if (bi = !1, (aa !== null || ua !== null) && (_n(), aa && (t = aa, l = ua, ua = aa = null, If(t), l)))
        for (t = 0; t < l.length; t++) If(l[t]);
    }
  }
  function Qa(l, t) {
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
        r(231, t, typeof e)
      );
    return e;
  }
  var Yt = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), Si = !1;
  if (Yt)
    try {
      var Xa = {};
      Object.defineProperty(Xa, "passive", {
        get: function() {
          Si = !0;
        }
      }), window.addEventListener("test", Xa, Xa), window.removeEventListener("test", Xa, Xa);
    } catch {
      Si = !1;
    }
  var ae = null, pi = null, Xu = null;
  function ls() {
    if (Xu) return Xu;
    var l, t = pi, e = t.length, a, u = "value" in ae ? ae.value : ae.textContent, n = u.length;
    for (l = 0; l < e && t[l] === u[l]; l++) ;
    var i = e - l;
    for (a = 1; a <= i && t[e - a] === u[n - a]; a++) ;
    return Xu = u.slice(l, 1 < a ? 1 - a : void 0);
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
      for (var f in l)
        l.hasOwnProperty(f) && (e = l[f], this[f] = e ? e(n) : n[f]);
      return this.isDefaultPrevented = (n.defaultPrevented != null ? n.defaultPrevented : n.returnValue === !1) ? Vu : ts, this.isPropagationStopped = ts, this;
    }
    return b(t.prototype, {
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
  }, Ku = kl(De), Za = b({}, De, { view: 0, detail: 0 }), hm = kl(Za), Ai, ji, Va, Ju = b({}, Za, {
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
    getModifierState: Ti,
    button: 0,
    buttons: 0,
    relatedTarget: function(l) {
      return l.relatedTarget === void 0 ? l.fromElement === l.srcElement ? l.toElement : l.fromElement : l.relatedTarget;
    },
    movementX: function(l) {
      return "movementX" in l ? l.movementX : (l !== Va && (Va && l.type === "mousemove" ? (Ai = l.screenX - Va.screenX, ji = l.screenY - Va.screenY) : ji = Ai = 0, Va = l), Ai);
    },
    movementY: function(l) {
      return "movementY" in l ? l.movementY : ji;
    }
  }), es = kl(Ju), vm = b({}, Ju, { dataTransfer: 0 }), ym = kl(vm), gm = b({}, Za, { relatedTarget: 0 }), zi = kl(gm), bm = b({}, De, {
    animationName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Sm = kl(bm), pm = b({}, De, {
    clipboardData: function(l) {
      return "clipboardData" in l ? l.clipboardData : window.clipboardData;
    }
  }), Am = kl(pm), jm = b({}, De, { data: 0 }), as = kl(jm), zm = {
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
  function Ti() {
    return Em;
  }
  var Nm = b({}, Za, {
    key: function(l) {
      if (l.key) {
        var t = zm[l.key] || l.key;
        if (t !== "Unidentified") return t;
      }
      return l.type === "keypress" ? (l = Zu(l), l === 13 ? "Enter" : String.fromCharCode(l)) : l.type === "keydown" || l.type === "keyup" ? Tm[l.keyCode] || "Unidentified" : "";
    },
    code: 0,
    location: 0,
    ctrlKey: 0,
    shiftKey: 0,
    altKey: 0,
    metaKey: 0,
    repeat: 0,
    locale: 0,
    getModifierState: Ti,
    charCode: function(l) {
      return l.type === "keypress" ? Zu(l) : 0;
    },
    keyCode: function(l) {
      return l.type === "keydown" || l.type === "keyup" ? l.keyCode : 0;
    },
    which: function(l) {
      return l.type === "keypress" ? Zu(l) : l.type === "keydown" || l.type === "keyup" ? l.keyCode : 0;
    }
  }), Om = kl(Nm), _m = b({}, Ju, {
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
  }), us = kl(_m), Mm = b({}, Za, {
    touches: 0,
    targetTouches: 0,
    changedTouches: 0,
    altKey: 0,
    metaKey: 0,
    ctrlKey: 0,
    shiftKey: 0,
    getModifierState: Ti
  }), Dm = kl(Mm), Um = b({}, De, {
    propertyName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Rm = kl(Um), Cm = b({}, Ju, {
    deltaX: function(l) {
      return "deltaX" in l ? l.deltaX : "wheelDeltaX" in l ? -l.wheelDeltaX : 0;
    },
    deltaY: function(l) {
      return "deltaY" in l ? l.deltaY : "wheelDeltaY" in l ? -l.wheelDeltaY : "wheelDelta" in l ? -l.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), Hm = kl(Cm), qm = b({}, De, {
    newState: 0,
    oldState: 0
  }), Bm = kl(qm), Ym = [9, 13, 27, 32], xi = Yt && "CompositionEvent" in window, Ka = null;
  Yt && "documentMode" in document && (Ka = document.documentMode);
  var Gm = Yt && "TextEvent" in window && !Ka, ns = Yt && (!xi || Ka && 8 < Ka && 11 >= Ka), is = " ", cs = !1;
  function fs(l, t) {
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
  function ss(l) {
    return l = l.detail, typeof l == "object" && "data" in l ? l.data : null;
  }
  var na = !1;
  function Lm(l, t) {
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
  function Qm(l, t) {
    if (na)
      return l === "compositionend" || !xi && fs(l, t) ? (l = ls(), Xu = pi = ae = null, na = !1, l) : null;
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
  function os(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t === "input" ? !!Xm[l.type] : t === "textarea";
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
  function Zm(l) {
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
    var Ei;
    if (Yt) {
      var Ni = "oninput" in document;
      if (!Ni) {
        var hs = document.createElement("div");
        hs.setAttribute("oninput", "return;"), Ni = typeof hs.oninput == "function";
      }
      Ei = Ni;
    } else Ei = !1;
    ms = Ei && (!document.documentMode || 9 < document.documentMode);
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
      ), Pf(Zm, t);
    }
  }
  function Vm(l, t, e) {
    l === "focusin" ? (vs(), Ja = t, wa = e, Ja.attachEvent("onpropertychange", ys)) : l === "focusout" && vs();
  }
  function Km(l) {
    if (l === "selectionchange" || l === "keyup" || l === "keydown")
      return wu(wa);
  }
  function Jm(l, t) {
    if (l === "click") return wu(t);
  }
  function wm(l, t) {
    if (l === "input" || l === "change")
      return wu(t);
  }
  function $m(l, t) {
    return l === t && (l !== 0 || 1 / l === 1 / t) || l !== l && t !== t;
  }
  var ct = typeof Object.is == "function" ? Object.is : $m;
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
  function bs(l, t) {
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
  function Ss(l, t) {
    return l && t ? l === t ? !0 : l && l.nodeType === 3 ? !1 : t && t.nodeType === 3 ? Ss(l, t.parentNode) : "contains" in l ? l.contains(t) : l.compareDocumentPosition ? !!(l.compareDocumentPosition(t) & 16) : !1 : !1;
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
  var Wm = Yt && "documentMode" in document && 11 >= document.documentMode, ia = null, _i = null, Wa = null, Mi = !1;
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
  }, Di = {}, js = {};
  Yt && (js = document.createElement("div").style, "AnimationEvent" in window || (delete ca.animationend.animation, delete ca.animationiteration.animation, delete ca.animationstart.animation), "TransitionEvent" in window || delete ca.transitionend.transition);
  function Re(l) {
    if (Di[l]) return Di[l];
    if (!ca[l]) return l;
    var t = ca[l], e;
    for (e in t)
      if (t.hasOwnProperty(e) && e in js)
        return Di[l] = t[e];
    return l;
  }
  var zs = Re("animationend"), Ts = Re("animationiteration"), xs = Re("animationstart"), km = Re("transitionrun"), Fm = Re("transitionstart"), Im = Re("transitioncancel"), Es = Re("transitionend"), Ns = /* @__PURE__ */ new Map(), Ui = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
    " "
  );
  Ui.push("scrollEnd");
  function Nt(l, t) {
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
      throw gu = 0, Zc = null, Error(r(185));
    for (var t = l.return; t !== null; )
      l = t, t = l.return;
    return l.tag === 3 ? l.stateNode : null;
  }
  var sa = {};
  function Pm(l, t, e, a) {
    this.tag = l, this.key = e, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = a, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function ft(l, t, e, a) {
    return new Pm(l, t, e, a);
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
      i = uv(
        l,
        e,
        B.current
      ) ? 26 : l === "html" || l === "head" || l === "body" ? 27 : 5;
    else
      l: switch (l) {
        case wl:
          return l = ft(31, e, t, u), l.elementType = wl, l.lanes = n, l;
        case El:
          return He(e.children, u, n, t);
        case Nl:
          i = 8, u |= 24;
          break;
        case cl:
          return l = ft(12, e, t, u | 2), l.elementType = cl, l.lanes = n, l;
        case ht:
          return l = ft(13, e, t, u), l.elementType = ht, l.lanes = n, l;
        case X:
          return l = ft(19, e, t, u), l.elementType = X, l.lanes = n, l;
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
            r(130, l === null ? "null" : typeof l, "")
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
  function bt(l, t) {
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
  var oa = [], da = 0, Pu = null, ka = 0, St = [], pt = 0, ue = null, Dt = 1, Ut = "";
  function Lt(l, t) {
    oa[da++] = ka, oa[da++] = Pu, Pu = l, ka = t;
  }
  function Us(l, t, e) {
    St[pt++] = Dt, St[pt++] = Ut, St[pt++] = ue, ue = l;
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
      ue = St[--pt], St[pt] = null, Ut = St[--pt], St[pt] = null, Dt = St[--pt], St[pt] = null;
  }
  function Rs(l, t) {
    St[pt++] = Dt, St[pt++] = Ut, St[pt++] = ue, Dt = t.id, Ut = t.overflow, ue = l;
  }
  var Yl = null, yl = null, el = !1, ne = null, At = !1, Li = Error(r(519));
  function ie(l) {
    var t = Error(
      r(
        418,
        1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML",
        ""
      )
    );
    throw Fa(bt(t, l)), Li;
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
        for (e = 0; e < Su.length; e++)
          I(Su[e], t);
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
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(r(317));
      yl = cr(l);
    } else if (t === 31) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(r(317));
      yl = cr(l);
    } else
      t === 27 ? (t = yl, pe(l.type) ? (l = of, of = null, yl = l) : yl = t) : yl = Yl ? zt(l.stateNode.nextSibling) : null;
    return !0;
  }
  function qe() {
    yl = Yl = null, el = !1;
  }
  function Qi() {
    var l = ne;
    return l !== null && (lt === null ? lt = l : lt.push.apply(
      lt,
      l
    ), ne = null), l;
  }
  function Fa(l) {
    ne === null ? ne = [l] : ne.push(l);
  }
  var Xi = m(null), Be = null, Qt = null;
  function ce(l, t, e) {
    R(Xi, t._currentValue), t._currentValue = e;
  }
  function Xt(l) {
    l._currentValue = Xi.current, E(Xi);
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
          var f = n;
          n = u;
          for (var o = 0; o < t.length; o++)
            if (f.context === t[o]) {
              n.lanes |= e, f = n.alternate, f !== null && (f.lanes |= e), Zi(
                n.return,
                e,
                l
              ), a || (i = null);
              break l;
            }
          n = f.next;
        }
      } else if (u.tag === 18) {
        if (i = u.return, i === null) throw Error(r(341));
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
        if (i === null) throw Error(r(387));
        if (i = i.memoizedProps, i !== null) {
          var f = u.type;
          ct(u.pendingProps.value, i.value) || (l !== null ? l.push(f) : l = [f]);
        }
      } else if (u === il.current) {
        if (i = u.alternate, i === null) throw Error(r(387));
        i.memoizedState.memoizedState !== u.memoizedState.memoizedState && (l !== null ? l.push(Tu) : l = [Tu]);
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
    Be = l, Qt = null, l = l.dependencies, l !== null && (l.firstContext = null);
  }
  function Gl(l) {
    return qs(Be, l);
  }
  function tn(l, t) {
    return Be === null && Ye(l), qs(l, t);
  }
  function qs(l, t) {
    var e = t._currentValue;
    if (t = { context: t, memoizedValue: e, next: null }, Qt === null) {
      if (l === null) throw Error(r(308));
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
  }, th = s.unstable_scheduleCallback, eh = s.unstable_NormalPriority, Ol = {
    $$typeof: Rl,
    Consumer: null,
    Provider: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0
  };
  function Ki() {
    return {
      controller: new lh(),
      data: /* @__PURE__ */ new Map(),
      refCount: 0
    };
  }
  function Ia(l) {
    l.refCount--, l.refCount === 0 && th(eh, function() {
      l.controller.abort();
    });
  }
  var Pa = null, Ji = 0, ha = 0, va = null;
  function ah(l, t) {
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
  var Ys = z.S;
  z.S = function(l, t) {
    jd = ut(), typeof t == "object" && t !== null && typeof t.then == "function" && ah(l, t), Ys !== null && Ys(l, t);
  };
  var Ge = m(null);
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
  var ya = Error(r(460)), $i = Error(r(474)), an = Error(r(542)), un = { then: function() {
  } };
  function Ls(l) {
    return l = l.status, l === "fulfilled" || l === "rejected";
  }
  function Qs(l, t, e) {
    switch (e = l[e], e === void 0 ? l.push(t) : e !== t && (t.then(Bt, Bt), t = e), t.status) {
      case "fulfilled":
        return t.value;
      case "rejected":
        throw l = t.reason, Zs(l), l;
      default:
        if (typeof t.status == "string") t.then(Bt, Bt);
        else {
          if (l = vl, l !== null && 100 < l.shellSuspendCounter)
            throw Error(r(482));
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
        throw Qe = t, ya;
    }
  }
  function Le(l) {
    try {
      var t = l._init;
      return t(l._payload);
    } catch (e) {
      throw e !== null && typeof e == "object" && typeof e.then == "function" ? (Qe = e, ya) : e;
    }
  }
  var Qe = null;
  function Xs() {
    if (Qe === null) throw Error(r(459));
    var l = Qe;
    return Qe = null, l;
  }
  function Zs(l) {
    if (l === ya || l === an)
      throw Error(r(483));
  }
  var ga = null, lu = 0;
  function nn(l) {
    var t = lu;
    return lu += 1, ga === null && (ga = []), Qs(ga, l, t);
  }
  function tu(l, t) {
    t = t.props.ref, l.ref = t !== void 0 ? t : null;
  }
  function cn(l, t) {
    throw t.$$typeof === C ? Error(r(525)) : (l = Object.prototype.toString.call(t), Error(
      r(
        31,
        l === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : l
      )
    ));
  }
  function Vs(l) {
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
    function f(h, d, v, T) {
      return d === null || d.tag !== 6 ? (d = qi(v, h.mode, T), d.return = h, d) : (d = u(d, v), d.return = h, d);
    }
    function o(h, d, v, T) {
      var G = v.type;
      return G === El ? A(
        h,
        d,
        v.props.children,
        T,
        v.key
      ) : d !== null && (d.elementType === G || typeof G == "object" && G !== null && G.$$typeof === Cl && Le(G) === d.type) ? (d = u(d, v.props), tu(d, v), d.return = h, d) : (d = Iu(
        v.type,
        v.key,
        v.props,
        null,
        h.mode,
        T
      ), tu(d, v), d.return = h, d);
    }
    function y(h, d, v, T) {
      return d === null || d.tag !== 4 || d.stateNode.containerInfo !== v.containerInfo || d.stateNode.implementation !== v.implementation ? (d = Bi(v, h.mode, T), d.return = h, d) : (d = u(d, v.children || []), d.return = h, d);
    }
    function A(h, d, v, T, G) {
      return d === null || d.tag !== 7 ? (d = He(
        v,
        h.mode,
        T,
        G
      ), d.return = h, d) : (d = u(d, v), d.return = h, d);
    }
    function x(h, d, v) {
      if (typeof d == "string" && d !== "" || typeof d == "number" || typeof d == "bigint")
        return d = qi(
          "" + d,
          h.mode,
          v
        ), d.return = h, d;
      if (typeof d == "object" && d !== null) {
        switch (d.$$typeof) {
          case O:
            return v = Iu(
              d.type,
              d.key,
              d.props,
              null,
              h.mode,
              v
            ), tu(v, d), v.return = h, v;
          case xl:
            return d = Bi(
              d,
              h.mode,
              v
            ), d.return = h, d;
          case Cl:
            return d = Le(d), x(h, d, v);
        }
        if (Et(d) || $l(d))
          return d = He(
            d,
            h.mode,
            v,
            null
          ), d.return = h, d;
        if (typeof d.then == "function")
          return x(h, nn(d), v);
        if (d.$$typeof === Rl)
          return x(
            h,
            tn(h, d),
            v
          );
        cn(h, d);
      }
      return null;
    }
    function g(h, d, v, T) {
      var G = d !== null ? d.key : null;
      if (typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint")
        return G !== null ? null : f(h, d, "" + v, T);
      if (typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case O:
            return v.key === G ? o(h, d, v, T) : null;
          case xl:
            return v.key === G ? y(h, d, v, T) : null;
          case Cl:
            return v = Le(v), g(h, d, v, T);
        }
        if (Et(v) || $l(v))
          return G !== null ? null : A(h, d, v, T, null);
        if (typeof v.then == "function")
          return g(
            h,
            d,
            nn(v),
            T
          );
        if (v.$$typeof === Rl)
          return g(
            h,
            d,
            tn(h, v),
            T
          );
        cn(h, v);
      }
      return null;
    }
    function S(h, d, v, T, G) {
      if (typeof T == "string" && T !== "" || typeof T == "number" || typeof T == "bigint")
        return h = h.get(v) || null, f(d, h, "" + T, G);
      if (typeof T == "object" && T !== null) {
        switch (T.$$typeof) {
          case O:
            return h = h.get(
              T.key === null ? v : T.key
            ) || null, o(d, h, T, G);
          case xl:
            return h = h.get(
              T.key === null ? v : T.key
            ) || null, y(d, h, T, G);
          case Cl:
            return T = Le(T), S(
              h,
              d,
              v,
              T,
              G
            );
        }
        if (Et(T) || $l(T))
          return h = h.get(v) || null, A(d, h, T, G, null);
        if (typeof T.then == "function")
          return S(
            h,
            d,
            v,
            nn(T),
            G
          );
        if (T.$$typeof === Rl)
          return S(
            h,
            d,
            v,
            tn(d, T),
            G
          );
        cn(d, T);
      }
      return null;
    }
    function q(h, d, v, T) {
      for (var G = null, al = null, Y = d, W = d = 0, ll = null; Y !== null && W < v.length; W++) {
        Y.index > W ? (ll = Y, Y = null) : ll = Y.sibling;
        var ul = g(
          h,
          Y,
          v[W],
          T
        );
        if (ul === null) {
          Y === null && (Y = ll);
          break;
        }
        l && Y && ul.alternate === null && t(h, Y), d = n(ul, d, W), al === null ? G = ul : al.sibling = ul, al = ul, Y = ll;
      }
      if (W === v.length)
        return e(h, Y), el && Lt(h, W), G;
      if (Y === null) {
        for (; W < v.length; W++)
          Y = x(h, v[W], T), Y !== null && (d = n(
            Y,
            d,
            W
          ), al === null ? G = Y : al.sibling = Y, al = Y);
        return el && Lt(h, W), G;
      }
      for (Y = a(Y); W < v.length; W++)
        ll = S(
          Y,
          h,
          W,
          v[W],
          T
        ), ll !== null && (l && ll.alternate !== null && Y.delete(
          ll.key === null ? W : ll.key
        ), d = n(
          ll,
          d,
          W
        ), al === null ? G = ll : al.sibling = ll, al = ll);
      return l && Y.forEach(function(xe) {
        return t(h, xe);
      }), el && Lt(h, W), G;
    }
    function Q(h, d, v, T) {
      if (v == null) throw Error(r(151));
      for (var G = null, al = null, Y = d, W = d = 0, ll = null, ul = v.next(); Y !== null && !ul.done; W++, ul = v.next()) {
        Y.index > W ? (ll = Y, Y = null) : ll = Y.sibling;
        var xe = g(h, Y, ul.value, T);
        if (xe === null) {
          Y === null && (Y = ll);
          break;
        }
        l && Y && xe.alternate === null && t(h, Y), d = n(xe, d, W), al === null ? G = xe : al.sibling = xe, al = xe, Y = ll;
      }
      if (ul.done)
        return e(h, Y), el && Lt(h, W), G;
      if (Y === null) {
        for (; !ul.done; W++, ul = v.next())
          ul = x(h, ul.value, T), ul !== null && (d = n(ul, d, W), al === null ? G = ul : al.sibling = ul, al = ul);
        return el && Lt(h, W), G;
      }
      for (Y = a(Y); !ul.done; W++, ul = v.next())
        ul = S(Y, h, W, ul.value, T), ul !== null && (l && ul.alternate !== null && Y.delete(ul.key === null ? W : ul.key), d = n(ul, d, W), al === null ? G = ul : al.sibling = ul, al = ul);
      return l && Y.forEach(function(vv) {
        return t(h, vv);
      }), el && Lt(h, W), G;
    }
    function ml(h, d, v, T) {
      if (typeof v == "object" && v !== null && v.type === El && v.key === null && (v = v.props.children), typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case O:
            l: {
              for (var G = v.key; d !== null; ) {
                if (d.key === G) {
                  if (G = v.type, G === El) {
                    if (d.tag === 7) {
                      e(
                        h,
                        d.sibling
                      ), T = u(
                        d,
                        v.props.children
                      ), T.return = h, h = T;
                      break l;
                    }
                  } else if (d.elementType === G || typeof G == "object" && G !== null && G.$$typeof === Cl && Le(G) === d.type) {
                    e(
                      h,
                      d.sibling
                    ), T = u(d, v.props), tu(T, v), T.return = h, h = T;
                    break l;
                  }
                  e(h, d);
                  break;
                } else t(h, d);
                d = d.sibling;
              }
              v.type === El ? (T = He(
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
          case xl:
            l: {
              for (G = v.key; d !== null; ) {
                if (d.key === G)
                  if (d.tag === 4 && d.stateNode.containerInfo === v.containerInfo && d.stateNode.implementation === v.implementation) {
                    e(
                      h,
                      d.sibling
                    ), T = u(d, v.children || []), T.return = h, h = T;
                    break l;
                  } else {
                    e(h, d);
                    break;
                  }
                else t(h, d);
                d = d.sibling;
              }
              T = Bi(v, h.mode, T), T.return = h, h = T;
            }
            return i(h);
          case Cl:
            return v = Le(v), ml(
              h,
              d,
              v,
              T
            );
        }
        if (Et(v))
          return q(
            h,
            d,
            v,
            T
          );
        if ($l(v)) {
          if (G = $l(v), typeof G != "function") throw Error(r(150));
          return v = G.call(v), Q(
            h,
            d,
            v,
            T
          );
        }
        if (typeof v.then == "function")
          return ml(
            h,
            d,
            nn(v),
            T
          );
        if (v.$$typeof === Rl)
          return ml(
            h,
            d,
            tn(h, v),
            T
          );
        cn(h, v);
      }
      return typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint" ? (v = "" + v, d !== null && d.tag === 6 ? (e(h, d.sibling), T = u(d, v), T.return = h, h = T) : (e(h, d), T = qi(v, h.mode, T), T.return = h, h = T), i(h)) : e(h, d);
    }
    return function(h, d, v, T) {
      try {
        lu = 0;
        var G = ml(
          h,
          d,
          v,
          T
        );
        return ga = null, G;
      } catch (Y) {
        if (Y === ya || Y === an) throw Y;
        var al = ft(29, Y, null, h.mode);
        return al.lanes = T, al.return = h, al;
      }
    };
  }
  var Xe = Vs(!0), Ks = Vs(!1), fe = !1;
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
    var n = u.firstBaseUpdate, i = u.lastBaseUpdate, f = u.shared.pending;
    if (f !== null) {
      u.shared.pending = null;
      var o = f, y = o.next;
      o.next = null, i === null ? n = y : i.next = y, i = o;
      var A = l.alternate;
      A !== null && (A = A.updateQueue, f = A.lastBaseUpdate, f !== i && (f === null ? A.firstBaseUpdate = y : f.next = y, A.lastBaseUpdate = o));
    }
    if (n !== null) {
      var x = u.baseState;
      i = 0, A = y = o = null, f = n;
      do {
        var g = f.lane & -536870913, S = g !== f.lane;
        if (S ? (P & g) === g : (a & g) === g) {
          g !== 0 && g === ha && (Ii = !0), A !== null && (A = A.next = {
            lane: 0,
            tag: f.tag,
            payload: f.payload,
            callback: null,
            next: null
          });
          l: {
            var q = l, Q = f;
            g = t;
            var ml = e;
            switch (Q.tag) {
              case 1:
                if (q = Q.payload, typeof q == "function") {
                  x = q.call(ml, x, g);
                  break l;
                }
                x = q;
                break l;
              case 3:
                q.flags = q.flags & -65537 | 128;
              case 0:
                if (q = Q.payload, g = typeof q == "function" ? q.call(ml, x, g) : q, g == null) break l;
                x = b({}, x, g);
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
          }, A === null ? (y = A = S, o = x) : A = A.next = S, i |= g;
        if (f = f.next, f === null) {
          if (f = u.shared.pending, f === null)
            break;
          S = f, f = S.next, S.next = null, u.lastBaseUpdate = S, u.shared.pending = null;
        }
      } while (!0);
      A === null && (o = x), u.baseState = o, u.firstBaseUpdate = y, u.lastBaseUpdate = A, n === null && (u.shared.lanes = 0), ve |= i, l.lanes = i, l.memoizedState = x;
    }
  }
  function Js(l, t) {
    if (typeof l != "function")
      throw Error(r(191, l));
    l.call(t);
  }
  function ws(l, t) {
    var e = l.callbacks;
    if (e !== null)
      for (l.callbacks = null, l = 0; l < e.length; l++)
        Js(e[l], t);
  }
  var ba = m(null), fn = m(0);
  function $s(l, t) {
    l = Ft, R(fn, l), R(ba, t), Ft = l | t.baseLanes;
  }
  function Pi() {
    R(fn, Ft), R(ba, ba.current);
  }
  function lc() {
    Ft = fn.current, E(ba), E(fn);
  }
  var st = m(null), jt = null;
  function de(l) {
    var t = l.alternate;
    R(zl, zl.current & 1), R(st, l), jt === null && (t === null || ba.current !== null || t.memoizedState !== null) && (jt = l);
  }
  function tc(l) {
    R(zl, zl.current), R(st, l), jt === null && (jt = l);
  }
  function Ws(l) {
    l.tag === 22 ? (R(zl, zl.current), R(st, l), jt === null && (jt = l)) : re();
  }
  function re() {
    R(zl, zl.current), R(st, st.current);
  }
  function ot(l) {
    E(st), jt === l && (jt = null), E(zl);
  }
  var zl = m(0);
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
  var Zt = 0, w = null, dl = null, _l = null, on = !1, Sa = !1, Ze = !1, dn = 0, nu = 0, pa = null, nh = 0;
  function pl() {
    throw Error(r(321));
  }
  function ec(l, t) {
    if (t === null) return !1;
    for (var e = 0; e < t.length && e < l.length; e++)
      if (!ct(l[e], t[e])) return !1;
    return !0;
  }
  function ac(l, t, e, a, u, n) {
    return Zt = n, w = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, z.H = l === null || l.memoizedState === null ? Ro : bc, Ze = !1, n = e(a, u), Ze = !1, Sa && (n = Fs(
      t,
      e,
      a,
      u
    )), ks(l), n;
  }
  function ks(l) {
    z.H = fu;
    var t = dl !== null && dl.next !== null;
    if (Zt = 0, _l = dl = w = null, on = !1, nu = 0, pa = null, t) throw Error(r(300));
    l === null || Ml || (l = l.dependencies, l !== null && ln(l) && (Ml = !0));
  }
  function Fs(l, t, e, a) {
    w = l;
    var u = 0;
    do {
      if (Sa && (pa = null), nu = 0, Sa = !1, 25 <= u) throw Error(r(301));
      if (u += 1, _l = dl = null, l.updateQueue != null) {
        var n = l.updateQueue;
        n.lastEffect = null, n.events = null, n.stores = null, n.memoCache != null && (n.memoCache.index = 0);
      }
      z.H = Co, n = t(e, a);
    } while (Sa);
    return n;
  }
  function ih() {
    var l = z.H, t = l.useState()[0];
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
    Zt = 0, _l = dl = w = null, Sa = !1, nu = dn = 0, pa = null;
  }
  function Kl() {
    var l = {
      memoizedState: null,
      baseState: null,
      baseQueue: null,
      queue: null,
      next: null
    };
    return _l === null ? w.memoizedState = _l = l : _l = _l.next = l, _l;
  }
  function Tl() {
    if (dl === null) {
      var l = w.alternate;
      l = l !== null ? l.memoizedState : null;
    } else l = dl.next;
    var t = _l === null ? w.memoizedState : _l.next;
    if (t !== null)
      _l = t, dl = l;
    else {
      if (l === null)
        throw w.alternate === null ? Error(r(467)) : Error(r(310));
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
    return nu += 1, pa === null && (pa = []), l = Qs(pa, l, t), t = w, (_l === null ? t.memoizedState : _l.next) === null && (t = t.alternate, z.H = t === null || t.memoizedState === null ? Ro : bc), l;
  }
  function mn(l) {
    if (l !== null && typeof l == "object") {
      if (typeof l.then == "function") return iu(l);
      if (l.$$typeof === Rl) return Gl(l);
    }
    throw Error(r(438, String(l)));
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
    var t = Tl();
    return fc(t, dl, l);
  }
  function fc(l, t, e) {
    var a = l.queue;
    if (a === null) throw Error(r(311));
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
      var f = i = null, o = null, y = t, A = !1;
      do {
        var x = y.lane & -536870913;
        if (x !== y.lane ? (P & x) === x : (Zt & x) === x) {
          var g = y.revertLane;
          if (g === 0)
            o !== null && (o = o.next = {
              lane: 0,
              revertLane: 0,
              gesture: null,
              action: y.action,
              hasEagerState: y.hasEagerState,
              eagerState: y.eagerState,
              next: null
            }), x === ha && (A = !0);
          else if ((Zt & g) === g) {
            y = y.next, g === ha && (A = !0);
            continue;
          } else
            x = {
              lane: 0,
              revertLane: y.revertLane,
              gesture: null,
              action: y.action,
              hasEagerState: y.hasEagerState,
              eagerState: y.eagerState,
              next: null
            }, o === null ? (f = o = x, i = n) : o = o.next = x, w.lanes |= g, ve |= g;
          x = y.action, Ze && e(n, x), n = y.hasEagerState ? y.eagerState : e(n, x);
        } else
          g = {
            lane: x,
            revertLane: y.revertLane,
            gesture: y.gesture,
            action: y.action,
            hasEagerState: y.hasEagerState,
            eagerState: y.eagerState,
            next: null
          }, o === null ? (f = o = g, i = n) : o = o.next = g, w.lanes |= x, ve |= x;
        y = y.next;
      } while (y !== null && y !== t);
      if (o === null ? i = n : o.next = f, !ct(n, l.memoizedState) && (Ml = !0, A && (e = va, e !== null)))
        throw e;
      l.memoizedState = n, l.baseState = i, l.baseQueue = o, a.lastRenderedState = n;
    }
    return u === null && (a.lanes = 0), [l.memoizedState, a.dispatch];
  }
  function sc(l) {
    var t = Tl(), e = t.queue;
    if (e === null) throw Error(r(311));
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
    var a = w, u = Tl(), n = el;
    if (n) {
      if (e === void 0) throw Error(r(407));
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
      ), vl === null) throw Error(r(349));
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
    var t = Kl();
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
  function ch(l, t, e, a, u) {
    if (gn(l)) throw Error(r(485));
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
      z.T !== null ? e(!0) : n.isTransition = !1, a(n), e = t.pending, e === null ? (n.next = t.pending = n, no(t, n)) : (n.next = e.next, t.pending = e.next = n);
    }
  }
  function no(l, t) {
    var e = t.action, a = t.payload, u = l.state;
    if (t.isTransition) {
      var n = z.T, i = {};
      z.T = i;
      try {
        var f = e(u, a), o = z.S;
        o !== null && o(i, f), io(l, t, f);
      } catch (y) {
        dc(l, t, y);
      } finally {
        n !== null && i.types !== null && (n.types = i.types), z.T = n;
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
                  if (u = zt(
                    u.nextSibling
                  ), u === null) {
                    u = null;
                    break t;
                  }
                }
                n = u.data, u = n === "F!" || n === "F" ? u : null;
              }
              if (u) {
                yl = zt(
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
    return e = Kl(), e.memoizedState = e.baseState = t, a = {
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
    ), a = Kl(), u = {
      state: t,
      dispatch: null,
      action: l,
      pending: null
    }, a.queue = u, e = ch.bind(
      null,
      w,
      u,
      n,
      e
    ), u.dispatch = e, a.memoizedState = l, [t, e, !1];
  }
  function ro(l) {
    var t = Tl();
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
    t = Tl();
    var u = t.queue, n = u.dispatch;
    return e !== t.memoizedState && (w.flags |= 2048, Aa(
      9,
      { destroy: void 0 },
      fh.bind(null, u, e),
      null
    )), [a, n, l];
  }
  function fh(l, t) {
    l.action = t;
  }
  function ho(l) {
    var t = Tl(), e = dl;
    if (e !== null)
      return mo(t, e, l);
    Tl(), t = t.memoizedState, e = Tl();
    var a = e.queue.dispatch;
    return e.memoizedState = l, [t, a, !1];
  }
  function Aa(l, t, e, a) {
    return l = { tag: l, create: e, deps: a, inst: t, next: null }, t = w.updateQueue, t === null && (t = rn(), w.updateQueue = t), e = t.lastEffect, e === null ? t.lastEffect = l.next = l : (a = e.next, e.next = l, l.next = a, t.lastEffect = l), l;
  }
  function vo() {
    return Tl().memoizedState;
  }
  function vn(l, t, e, a) {
    var u = Kl();
    w.flags |= l, u.memoizedState = Aa(
      1 | t,
      { destroy: void 0 },
      e,
      a === void 0 ? null : a
    );
  }
  function yn(l, t, e, a) {
    var u = Tl();
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
  function sh(l) {
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
    var t = Tl().memoizedState;
    return sh({ ref: t, nextImpl: l }), function() {
      if ((nl & 2) !== 0) throw Error(r(440));
      return t.impl.apply(void 0, arguments);
    };
  }
  function bo(l, t) {
    return yn(4, 2, l, t);
  }
  function So(l, t) {
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
  function jo(l, t) {
    var e = Tl();
    t = t === void 0 ? null : t;
    var a = e.memoizedState;
    return t !== null && ec(t, a[1]) ? a[0] : (e.memoizedState = [l, t], l);
  }
  function zo(l, t) {
    var e = Tl();
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
    return e === void 0 || (Zt & 1073741824) !== 0 && (P & 261930) === 0 ? l.memoizedState = t : (l.memoizedState = e, l = Td(), w.lanes |= l, ve |= l, e);
  }
  function To(l, t, e, a) {
    return ct(e, t) ? e : ba.current !== null ? (l = hc(l, e, a), ct(l, t) || (Ml = !0), l) : (Zt & 42) === 0 || (Zt & 1073741824) !== 0 && (P & 261930) === 0 ? (Ml = !0, l.memoizedState = e) : (l = Td(), w.lanes |= l, ve |= l, t);
  }
  function xo(l, t, e, a, u) {
    var n = U.p;
    U.p = n !== 0 && 8 > n ? n : 8;
    var i = z.T, f = {};
    z.T = f, gc(l, !1, t, e);
    try {
      var o = u(), y = z.S;
      if (y !== null && y(f, o), o !== null && typeof o == "object" && typeof o.then == "function") {
        var A = uh(
          o,
          a
        );
        cu(
          l,
          t,
          A,
          mt(l)
        );
      } else
        cu(
          l,
          t,
          a,
          mt(l)
        );
    } catch (x) {
      cu(
        l,
        t,
        { then: function() {
        }, status: "rejected", reason: x },
        mt()
      );
    } finally {
      U.p = n, i !== null && f.types !== null && (i.types = f.types), z.T = i;
    }
  }
  function oh() {
  }
  function vc(l, t, e, a) {
    if (l.tag !== 5) throw Error(r(476));
    var u = Eo(l).queue;
    xo(
      l,
      u,
      t,
      V,
      e === null ? oh : function() {
        return No(l), e(a);
      }
    );
  }
  function Eo(l) {
    var t = l.memoizedState;
    if (t !== null) return t;
    t = {
      memoizedState: V,
      baseState: V,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Vt,
        lastRenderedState: V
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
    var t = Eo(l);
    t.next === null && (t = l.alternate.memoizedState), cu(
      l,
      t.next.queue,
      {},
      mt()
    );
  }
  function yc() {
    return Gl(Tu);
  }
  function Oo() {
    return Tl().memoizedState;
  }
  function _o() {
    return Tl().memoizedState;
  }
  function dh(l) {
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
  function rh(l, t, e) {
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
          var i = t.lastRenderedState, f = n(i, e);
          if (u.hasEagerState = !0, u.eagerState = f, ct(f, i))
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
      if (t) throw Error(r(479));
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
    Sa = on = !0;
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
      return Kl().memoizedState = [
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
      var e = Kl();
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
      var a = Kl();
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
      }, a.queue = l, l = l.dispatch = rh.bind(
        null,
        w,
        l
      ), [a.memoizedState, l];
    },
    useRef: function(l) {
      var t = Kl();
      return l = { current: l }, t.memoizedState = l;
    },
    useState: function(l) {
      l = oc(l);
      var t = l.queue, e = Mo.bind(null, w, t);
      return t.dispatch = e, [l.memoizedState, e];
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = Kl();
      return hc(e, l, t);
    },
    useTransition: function() {
      var l = oc(!1);
      return l = xo.bind(
        null,
        w,
        l.queue,
        !0,
        !1
      ), Kl().memoizedState = l, [!1, l];
    },
    useSyncExternalStore: function(l, t, e) {
      var a = w, u = Kl();
      if (el) {
        if (e === void 0)
          throw Error(r(407));
        e = e();
      } else {
        if (e = t(), vl === null)
          throw Error(r(349));
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
      var l = Kl(), t = vl.identifierPrefix;
      if (el) {
        var e = Ut, a = Dt;
        e = (a & ~(1 << 32 - it(a) - 1)).toString(32) + e, t = "_" + t + "R_" + e, e = dn++, 0 < e && (t += "H" + e.toString(32)), t += "_";
      } else
        e = nh++, t = "_" + t + "r_" + e.toString(32) + "_";
      return l.memoizedState = t;
    },
    useHostTransitionStatus: yc,
    useFormState: oo,
    useActionState: oo,
    useOptimistic: function(l) {
      var t = Kl();
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
      return Kl().memoizedState = dh.bind(
        null,
        w
      );
    },
    useEffectEvent: function(l) {
      var t = Kl(), e = { impl: l };
      return t.memoizedState = e, function() {
        if ((nl & 2) !== 0)
          throw Error(r(440));
        return e.impl.apply(void 0, arguments);
      };
    }
  }, bc = {
    readContext: Gl,
    use: mn,
    useCallback: jo,
    useContext: Gl,
    useEffect: rc,
    useImperativeHandle: Ao,
    useInsertionEffect: bo,
    useLayoutEffect: So,
    useMemo: zo,
    useReducer: hn,
    useRef: vo,
    useState: function() {
      return hn(Vt);
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = Tl();
      return To(
        e,
        dl.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = hn(Vt)[0], t = Tl().memoizedState;
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
      var e = Tl();
      return uo(e, dl, l, t);
    },
    useMemoCache: cc,
    useCacheRefresh: _o
  };
  bc.useEffectEvent = go;
  var Co = {
    readContext: Gl,
    use: mn,
    useCallback: jo,
    useContext: Gl,
    useEffect: rc,
    useImperativeHandle: Ao,
    useInsertionEffect: bo,
    useLayoutEffect: So,
    useMemo: zo,
    useReducer: sc,
    useRef: vo,
    useState: function() {
      return sc(Vt);
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = Tl();
      return dl === null ? hc(e, l, t) : To(
        e,
        dl.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = sc(Vt)[0], t = Tl().memoizedState;
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
      var e = Tl();
      return dl !== null ? uo(e, dl, l, t) : (e.baseState = l, [l, e.queue.dispatch]);
    },
    useMemoCache: cc,
    useCacheRefresh: _o
  };
  Co.useEffectEvent = go;
  function Sc(l, t, e, a) {
    t = l.memoizedState, e = e(a, t), e = e == null ? t : b({}, t, e), l.memoizedState = e, l.lanes === 0 && (l.updateQueue.baseState = e);
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
      e === t && (e = b({}, e));
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
  function bn(l, t) {
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
      bn(l, t);
    }, e;
  }
  function Qo(l) {
    return l = se(l), l.tag = 3, l;
  }
  function Xo(l, t, e, a) {
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
      ), e = st.current, e !== null) {
        switch (e.tag) {
          case 31:
          case 13:
            return jt === null ? Mn() : e.alternate === null && Al === 0 && (Al = 3), e.flags &= -257, e.flags |= 65536, e.lanes = u, a === un ? e.flags |= 16384 : (t = e.updateQueue, t === null ? e.updateQueue = /* @__PURE__ */ new Set([a]) : t.add(a), Jc(l, a, u)), !1;
          case 22:
            return e.flags |= 65536, a === un ? e.flags |= 16384 : (t = e.updateQueue, t === null ? (t = {
              transitions: null,
              markerInstances: null,
              retryQueue: /* @__PURE__ */ new Set([a])
            }, e.updateQueue = t) : (e = t.retryQueue, e === null ? t.retryQueue = /* @__PURE__ */ new Set([a]) : e.add(a)), Jc(l, a, u)), !1;
        }
        throw Error(r(435, e.tag));
      }
      return Jc(l, a, u), Mn(), !1;
    }
    if (el)
      return t = st.current, t !== null ? ((t.flags & 65536) === 0 && (t.flags |= 256), t.flags |= 65536, t.lanes = u, a !== Li && (l = Error(r(422), { cause: a }), Fa(bt(l, e)))) : (a !== Li && (t = Error(r(423), {
        cause: a
      }), Fa(
        bt(t, e)
      )), l = l.current.alternate, l.flags |= 65536, u &= -u, l.lanes |= u, a = bt(a, e), u = Ac(
        l.stateNode,
        a,
        u
      ), Fi(l, u), Al !== 4 && (Al = 2)), !1;
    var n = Error(r(520), { cause: a });
    if (n = bt(n, e), yu === null ? yu = [n] : yu.push(n), Al !== 4 && (Al = 2), t === null) return !0;
    a = bt(a, e), e = t;
    do {
      switch (e.tag) {
        case 3:
          return e.flags |= 65536, l = u & -u, e.lanes |= l, l = Ac(e.stateNode, a, l), Fi(e, l), !1;
        case 1:
          if (t = e.type, n = e.stateNode, (e.flags & 128) === 0 && (typeof t.getDerivedStateFromError == "function" || n !== null && typeof n.componentDidCatch == "function" && (ye === null || !ye.has(n))))
            return e.flags |= 65536, u &= -u, e.lanes |= u, u = Qo(u), Xo(
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
  var jc = Error(r(461)), Ml = !1;
  function Ll(l, t, e, a) {
    t.child = l === null ? Ks(t, null, e, a) : Xe(
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
      for (var f in a)
        f !== "ref" && (i[f] = a[f]);
    } else i = a;
    return Ye(t), a = ac(
      l,
      t,
      e,
      i,
      n,
      u
    ), f = uc(), l !== null && !Ml ? (nc(l, t, u), Kt(l, t, u)) : (el && f && Yi(t), t.flags |= 1, Ll(l, t, a, u), t.child);
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
    return zc(
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
  function Sn(l, t) {
    return t = An(
      { mode: t.mode, children: t.children },
      l.mode
    ), t.ref = l.ref, l.child = t, t.return = l, t;
  }
  function $o(l, t, e) {
    return Xe(t, l.child, null, e), l = Sn(t, t.pendingProps), l.flags |= 2, ot(t), t.memoizedState = null, l;
  }
  function hh(l, t, e) {
    var a = t.pendingProps, u = (t.flags & 128) !== 0;
    if (t.flags &= -129, l === null) {
      if (el) {
        if (a.mode === "hidden")
          return l = Sn(t, a), t.lanes = 536870912, su(null, l);
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
      return Sn(t, a);
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
        else throw Error(r(558));
      else if (Ml || ma(l, t, e, !1), u = (e & l.childLanes) !== 0, Ml || u) {
        if (a = vl, a !== null && (i = Bf(a, e), i !== 0 && i !== n.retryLane))
          throw n.retryLane = i, Ce(l, i), tt(a, l, i), jc;
        Mn(), t = $o(
          l,
          t,
          e
        );
      } else
        l = n.treeContext, yl = zt(i.nextSibling), Yl = t, el = !0, ne = null, At = !1, l !== null && Rs(t, l), t = Sn(t, a), t.flags |= 4096;
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
        throw Error(r(284));
      (l === null || l.ref !== e) && (t.flags |= 4194816);
    }
  }
  function zc(l, t, e, a, u) {
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
      typeof i == "object" && i !== null && (n = Gl(i)), n = new e(a, n), t.memoizedState = n.state !== null && n.state !== void 0 ? n.state : null, n.updater = pc, t.stateNode = n, n._reactInternals = t, n = t.stateNode, n.props = a, n.state = t.memoizedState, n.refs = {}, Wi(t), i = e.contextType, n.context = typeof i == "object" && i !== null ? Gl(i) : sa, n.state = t.memoizedState, i = e.getDerivedStateFromProps, typeof i == "function" && (Sc(
        t,
        e,
        i,
        a
      ), n.state = t.memoizedState), typeof e.getDerivedStateFromProps == "function" || typeof n.getSnapshotBeforeUpdate == "function" || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (i = n.state, typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount(), i !== n.state && pc.enqueueReplaceState(n, n.state, null), uu(t, a, n, u), au(), n.state = t.memoizedState), typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !0;
    } else if (l === null) {
      n = t.stateNode;
      var f = t.memoizedProps, o = Ve(e, f);
      n.props = o;
      var y = n.context, A = e.contextType;
      i = sa, typeof A == "object" && A !== null && (i = Gl(A));
      var x = e.getDerivedStateFromProps;
      A = typeof x == "function" || typeof n.getSnapshotBeforeUpdate == "function", f = t.pendingProps !== f, A || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (f || y !== i) && qo(
        t,
        n,
        a,
        i
      ), fe = !1;
      var g = t.memoizedState;
      n.state = g, uu(t, a, n, u), au(), y = t.memoizedState, f || g !== y || fe ? (typeof x == "function" && (Sc(
        t,
        e,
        x,
        a
      ), y = t.memoizedState), (o = fe || Ho(
        t,
        e,
        o,
        a,
        g,
        y,
        i
      )) ? (A || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount()), typeof n.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = a, t.memoizedState = y), n.props = a, n.state = y, n.context = i, a = o) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !1);
    } else {
      n = t.stateNode, ki(l, t), i = t.memoizedProps, A = Ve(e, i), n.props = A, x = t.pendingProps, g = n.context, y = e.contextType, o = sa, typeof y == "object" && y !== null && (o = Gl(y)), f = e.getDerivedStateFromProps, (y = typeof f == "function" || typeof n.getSnapshotBeforeUpdate == "function") || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (i !== x || g !== o) && qo(
        t,
        n,
        a,
        o
      ), fe = !1, g = t.memoizedState, n.state = g, uu(t, a, n, u), au();
      var S = t.memoizedState;
      i !== x || g !== S || fe || l !== null && l.dependencies !== null && ln(l.dependencies) ? (typeof f == "function" && (Sc(
        t,
        e,
        f,
        a
      ), S = t.memoizedState), (A = fe || Ho(
        t,
        e,
        A,
        a,
        g,
        S,
        o
      ) || l !== null && l.dependencies !== null && ln(l.dependencies)) ? (y || typeof n.UNSAFE_componentWillUpdate != "function" && typeof n.componentWillUpdate != "function" || (typeof n.componentWillUpdate == "function" && n.componentWillUpdate(a, S, o), typeof n.UNSAFE_componentWillUpdate == "function" && n.UNSAFE_componentWillUpdate(
        a,
        S,
        o
      )), typeof n.componentDidUpdate == "function" && (t.flags |= 4), typeof n.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), t.memoizedProps = a, t.memoizedState = S), n.props = a, n.state = S, n.context = o, a = A) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), a = !1);
    }
    return n = a, pn(l, t), a = (t.flags & 128) !== 0, n || a ? (n = t.stateNode, e = a && typeof e.getDerivedStateFromError != "function" ? null : n.render(), t.flags |= 1, l !== null && a ? (t.child = Xe(
      t,
      l.child,
      null,
      u
    ), t.child = Xe(
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
  var Tc = {
    dehydrated: null,
    treeContext: null,
    retryLane: 0,
    hydrationErrors: null
  };
  function xc(l) {
    return { baseLanes: l, cachePool: Gs() };
  }
  function Ec(l, t, e) {
    return l = l !== null ? l.childLanes & ~e : 0, t && (l |= rt), l;
  }
  function Io(l, t, e) {
    var a = t.pendingProps, u = !1, n = (t.flags & 128) !== 0, i;
    if ((i = n) || (i = l !== null && l.memoizedState === null ? !1 : (zl.current & 2) !== 0), i && (u = !0, t.flags &= -129), i = (t.flags & 32) !== 0, t.flags &= -33, l === null) {
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
      var f = a.children;
      return a = a.fallback, u ? (re(), u = t.mode, f = An(
        { mode: "hidden", children: f },
        u
      ), a = He(
        a,
        u,
        e,
        null
      ), f.return = t, a.return = t, f.sibling = a, t.child = f, a = t.child, a.memoizedState = xc(e), a.childLanes = Ec(
        l,
        i,
        e
      ), t.memoizedState = Tc, su(null, a)) : (de(t), Nc(t, f));
    }
    var o = l.memoizedState;
    if (o !== null && (f = o.dehydrated, f !== null)) {
      if (n)
        t.flags & 256 ? (de(t), t.flags &= -257, t = Oc(
          l,
          t,
          e
        )) : t.memoizedState !== null ? (re(), t.child = l.child, t.flags |= 128, t = null) : (re(), f = a.fallback, u = t.mode, a = An(
          { mode: "visible", children: a.children },
          u
        ), f = He(
          f,
          u,
          e,
          null
        ), f.flags |= 2, a.return = t, f.return = t, a.sibling = f, t.child = a, Xe(
          t,
          l.child,
          null,
          e
        ), a = t.child, a.memoizedState = xc(e), a.childLanes = Ec(
          l,
          i,
          e
        ), t.memoizedState = Tc, t = su(null, a));
      else if (de(t), sf(f)) {
        if (i = f.nextSibling && f.nextSibling.dataset, i) var y = i.dgst;
        i = y, a = Error(r(419)), a.stack = "", a.digest = i, Fa({ value: a, source: null, stack: null }), t = Oc(
          l,
          t,
          e
        );
      } else if (Ml || ma(l, t, e, !1), i = (e & l.childLanes) !== 0, Ml || i) {
        if (i = vl, i !== null && (a = Bf(i, e), a !== 0 && a !== o.retryLane))
          throw o.retryLane = a, Ce(l, a), tt(i, l, a), jc;
        ff(f) || Mn(), t = Oc(
          l,
          t,
          e
        );
      } else
        ff(f) ? (t.flags |= 192, t.child = l.child, t = null) : (l = o.treeContext, yl = zt(
          f.nextSibling
        ), Yl = t, el = !0, ne = null, At = !1, l !== null && Rs(t, l), t = Nc(
          t,
          a.children
        ), t.flags |= 4096);
      return t;
    }
    return u ? (re(), f = a.fallback, u = t.mode, o = l.child, y = o.sibling, a = Gt(o, {
      mode: "hidden",
      children: a.children
    }), a.subtreeFlags = o.subtreeFlags & 65011712, y !== null ? f = Gt(
      y,
      f
    ) : (f = He(
      f,
      u,
      e,
      null
    ), f.flags |= 2), f.return = t, a.return = t, a.sibling = f, t.child = a, su(null, a), a = t.child, f = l.child.memoizedState, f === null ? f = xc(e) : (u = f.cachePool, u !== null ? (o = Ol._currentValue, u = u.parent !== o ? { parent: o, pool: o } : u) : u = Gs(), f = {
      baseLanes: f.baseLanes | e,
      cachePool: u
    }), a.memoizedState = f, a.childLanes = Ec(
      l,
      i,
      e
    ), t.memoizedState = Tc, su(l.child, a)) : (de(t), e = l.child, l = e.sibling, e = Gt(e, {
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
    return Xe(t, l.child, null, e), l = Nc(
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
    var i = zl.current, f = (i & 2) !== 0;
    if (f ? (i = i & 1 | 2, t.flags |= 128) : i &= 1, R(zl, i), Ll(l, t, a, e), a = el ? ka : 0, !f && l !== null && (l.flags & 128) !== 0)
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
      throw Error(r(153));
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
  function vh(l, t, e) {
    switch (t.tag) {
      case 3:
        Vl(t, t.stateNode.containerInfo), ce(t, Ol, l.memoizedState.cache), qe();
        break;
      case 27:
      case 5:
        Ha(t);
        break;
      case 4:
        Vl(t, t.stateNode.containerInfo);
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
        if (u = t.memoizedState, u !== null && (u.rendering = null, u.tail = null, u.lastEffect = null), R(zl, zl.current), a) break;
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
          return Ml = !1, vh(
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
            )) : (t.tag = 0, t = zc(
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
            throw t = Ht(l) || l, Error(r(306, t, ""));
          }
        }
        return t;
      case 0:
        return zc(
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
          if (Vl(
            t,
            t.stateNode.containerInfo
          ), l === null) throw Error(r(387));
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
              u = bt(
                Error(r(424)),
                t
              ), Fa(u), t = Fo(
                l,
                t,
                a,
                e
              );
              break l;
            } else
              for (l = t.stateNode.containerInfo, l.nodeType === 9 ? l = l.body : l = l.nodeName === "HTML" ? l.ownerDocument.body : l, yl = zt(l.firstChild), Yl = t, el = !0, ne = null, At = !0, e = Ks(
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
        ).createElement(e), a[Bl] = t, a[Wl] = l, Ql(a, e, l), Hl(a), t.stateNode = a) : t.memoizedState = rr(
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
        ), Yl = t, At = !0, u = yl, pe(t.type) ? (of = u, yl = zt(a.firstChild)) : yl = u), Ll(
          l,
          t,
          t.pendingProps.children,
          e
        ), pn(l, t), l === null && (t.flags |= 4194304), t.child;
      case 5:
        return l === null && el && ((u = a = yl) && (a = Kh(
          a,
          t.type,
          t.pendingProps,
          At
        ), a !== null ? (t.stateNode = a, Yl = t, yl = zt(a.firstChild), At = !1, u = !0) : u = !1), u || ie(t)), Ha(t), u = t.type, n = t.pendingProps, i = l !== null ? l.memoizedProps : null, a = n.children, uf(u, n) ? a = null : i !== null && uf(u, i) && (t.flags |= 32), t.memoizedState !== null && (u = ac(
          l,
          t,
          ih,
          null,
          null,
          e
        ), Tu._currentValue = u), pn(l, t), Ll(l, t, a, e), t.child;
      case 6:
        return l === null && el && ((l = e = yl) && (e = Jh(
          e,
          t.pendingProps,
          At
        ), e !== null ? (t.stateNode = e, Yl = t, yl = null, l = !0) : l = !1), l || ie(t)), null;
      case 13:
        return Io(l, t, e);
      case 4:
        return Vl(
          t,
          t.stateNode.containerInfo
        ), a = t.pendingProps, l === null ? t.child = Xe(
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
        return hh(l, t, e);
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
    throw Error(r(156, t.tag));
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
          throw Qe = un, $i;
    } else l.flags &= -16777217;
  }
  function ed(l, t) {
    if (t.type !== "stylesheet" || (t.state.loading & 4) !== 0)
      l.flags &= -16777217;
    else if (l.flags |= 16777216, !gr(t))
      if (Od()) l.flags |= 8192;
      else
        throw Qe = un, $i;
  }
  function jn(l, t) {
    t !== null && (l.flags |= 4), l.flags & 16384 && (t = l.tag !== 22 ? Cf() : 536870912, l.lanes |= t, xa |= t);
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
  function yh(l, t, e) {
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
        return e = t.stateNode, a = null, l !== null && (a = l.memoizedState.cache), t.memoizedState.cache !== a && (t.flags |= 2048), Xt(Ol), jl(), e.pendingContext && (e.context = e.pendingContext, e.pendingContext = null), (l === null || l.child === null) && (ra(t) ? Jt(t) : l === null || l.memoizedState.isDehydrated && (t.flags & 256) === 0 || (t.flags |= 1024, Qi())), gl(t), null;
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
              throw Error(r(166));
            return gl(t), null;
          }
          l = B.current, ra(t) ? Cs(t) : (l = sr(u, a, e), t.stateNode = l, Jt(t));
        }
        return gl(t), null;
      case 5:
        if (Uu(t), u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Jt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(r(166));
            return gl(t), null;
          }
          if (n = B.current, ra(t))
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
            throw Error(r(166));
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
              if (!a) throw Error(r(318));
              if (l = t.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(r(557));
              l[Bl] = t;
            } else
              qe(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            gl(t), l = !1;
          } else
            e = Qi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = e), l = !0;
          if (!l)
            return t.flags & 256 ? (ot(t), t) : (ot(t), null);
          if ((t.flags & 128) !== 0)
            throw Error(r(558));
        }
        return gl(t), null;
      case 13:
        if (a = t.memoizedState, l === null || l.memoizedState !== null && l.memoizedState.dehydrated !== null) {
          if (u = ra(t), a !== null && a.dehydrated !== null) {
            if (l === null) {
              if (!u) throw Error(r(318));
              if (u = t.memoizedState, u = u !== null ? u.dehydrated : null, !u) throw Error(r(317));
              u[Bl] = t;
            } else
              qe(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            gl(t), u = !1;
          } else
            u = Qi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = u), u = !0;
          if (!u)
            return t.flags & 256 ? (ot(t), t) : (ot(t), null);
        }
        return ot(t), (t.flags & 128) !== 0 ? (t.lanes = e, t) : (e = a !== null, l = l !== null && l.memoizedState !== null, e && (a = t.child, u = null, a.alternate !== null && a.alternate.memoizedState !== null && a.alternate.memoizedState.cachePool !== null && (u = a.alternate.memoizedState.cachePool.pool), n = null, a.memoizedState !== null && a.memoizedState.cachePool !== null && (n = a.memoizedState.cachePool.pool), n !== u && (a.flags |= 2048)), e !== l && e && (t.child.flags |= 8192), jn(t, t.updateQueue), gl(t), null);
      case 4:
        return jl(), l === null && Pc(t.stateNode.containerInfo), gl(t), null;
      case 10:
        return Xt(t.type), gl(t), null;
      case 19:
        if (E(zl), a = t.memoizedState, a === null) return gl(t), null;
        if (u = (t.flags & 128) !== 0, n = a.rendering, n === null)
          if (u) ou(a, !1);
          else {
            if (Al !== 0 || l !== null && (l.flags & 128) !== 0)
              for (l = t.child; l !== null; ) {
                if (n = sn(l), n !== null) {
                  for (t.flags |= 128, ou(a, !1), l = n.updateQueue, t.updateQueue = l, jn(t, l), t.subtreeFlags = 0, l = e, e = t.child; e !== null; )
                    _s(e, l), e = e.sibling;
                  return R(
                    zl,
                    zl.current & 1 | 2
                  ), el && Lt(t, a.treeForkCount), t.child;
                }
                l = l.sibling;
              }
            a.tail !== null && ut() > Nn && (t.flags |= 128, u = !0, ou(a, !1), t.lanes = 4194304);
          }
        else {
          if (!u)
            if (l = sn(n), l !== null) {
              if (t.flags |= 128, u = !0, l = l.updateQueue, t.updateQueue = l, jn(t, l), ou(a, !0), a.tail === null && a.tailMode === "hidden" && !n.alternate && !el)
                return gl(t), null;
            } else
              2 * ut() - a.renderingStartTime > Nn && e !== 536870912 && (t.flags |= 128, u = !0, ou(a, !1), t.lanes = 4194304);
          a.isBackwards ? (n.sibling = t.child, t.child = n) : (l = a.last, l !== null ? l.sibling = n : t.child = n, a.last = n);
        }
        return a.tail !== null ? (l = a.tail, a.rendering = l, a.tail = l.sibling, a.renderingStartTime = ut(), l.sibling = null, e = zl.current, R(
          zl,
          u ? e & 1 | 2 : e & 1
        ), el && Lt(t, a.treeForkCount), l) : (gl(t), null);
      case 22:
      case 23:
        return ot(t), lc(), a = t.memoizedState !== null, l !== null ? l.memoizedState !== null !== a && (t.flags |= 8192) : a && (t.flags |= 8192), a ? (e & 536870912) !== 0 && (t.flags & 128) === 0 && (gl(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : gl(t), e = t.updateQueue, e !== null && jn(t, e.retryQueue), e = null, l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (e = l.memoizedState.cachePool.pool), a = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (a = t.memoizedState.cachePool.pool), a !== e && (t.flags |= 2048), l !== null && E(Ge), null;
      case 24:
        return e = null, l !== null && (e = l.memoizedState.cache), t.memoizedState.cache !== e && (t.flags |= 2048), Xt(Ol), gl(t), null;
      case 25:
        return null;
      case 30:
        return null;
    }
    throw Error(r(156, t.tag));
  }
  function gh(l, t) {
    switch (Gi(t), t.tag) {
      case 1:
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 3:
        return Xt(Ol), jl(), l = t.flags, (l & 65536) !== 0 && (l & 128) === 0 ? (t.flags = l & -65537 | 128, t) : null;
      case 26:
      case 27:
      case 5:
        return Uu(t), null;
      case 31:
        if (t.memoizedState !== null) {
          if (ot(t), t.alternate === null)
            throw Error(r(340));
          qe();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 13:
        if (ot(t), l = t.memoizedState, l !== null && l.dehydrated !== null) {
          if (t.alternate === null)
            throw Error(r(340));
          qe();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 19:
        return E(zl), null;
      case 4:
        return jl(), null;
      case 10:
        return Xt(t.type), null;
      case 22:
      case 23:
        return ot(t), lc(), l !== null && E(Ge), l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 24:
        return Xt(Ol), null;
      case 25:
        return null;
      default:
        return null;
    }
  }
  function ad(l, t) {
    switch (Gi(t), t.tag) {
      case 3:
        Xt(Ol), jl();
        break;
      case 26:
      case 27:
      case 5:
        Uu(t);
        break;
      case 4:
        jl();
        break;
      case 31:
        t.memoizedState !== null && ot(t);
        break;
      case 13:
        ot(t);
        break;
      case 19:
        E(zl);
        break;
      case 10:
        Xt(t.type);
        break;
      case 22:
      case 23:
        ot(t), lc(), l !== null && E(Ge);
        break;
      case 24:
        Xt(Ol);
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
    } catch (f) {
      sl(t, t.return, f);
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
              var o = e, y = f;
              try {
                y();
              } catch (A) {
                sl(
                  u,
                  o,
                  A
                );
              }
            }
          }
          a = a.next;
        } while (a !== n);
      }
    } catch (A) {
      sl(t, t.return, A);
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
      Gh(a, l.type, e, t), a[Wl] = t;
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
  function zn(l, t, e) {
    var a = l.tag;
    if (a === 5 || a === 6)
      l = l.stateNode, t ? e.insertBefore(l, t) : e.appendChild(l);
    else if (a !== 4 && (a === 27 && pe(l.type) && (e = l.stateNode), l = l.child, l !== null))
      for (zn(l, t, e), l = l.sibling; l !== null; )
        zn(l, t, e), l = l.sibling;
  }
  function fd(l) {
    var t = l.stateNode, e = l.memoizedProps;
    try {
      for (var a = l.type, u = t.attributes; u.length; )
        t.removeAttributeNode(u[0]);
      Ql(t, a, e), t[Bl] = l, t[Wl] = e;
    } catch (n) {
      sl(l, l.return, n);
    }
  }
  var wt = !1, Dl = !1, Hc = !1, sd = typeof WeakSet == "function" ? WeakSet : Set, ql = null;
  function bh(l, t) {
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
            var i = 0, f = -1, o = -1, y = 0, A = 0, x = l, g = null;
            t: for (; ; ) {
              for (var S; x !== e || u !== 0 && x.nodeType !== 3 || (f = i + u), x !== n || a !== 0 && x.nodeType !== 3 || (o = i + a), x.nodeType === 3 && (i += x.nodeValue.length), (S = x.firstChild) !== null; )
                g = x, x = S;
              for (; ; ) {
                if (x === l) break t;
                if (g === e && ++y === u && (f = i), g === n && ++A === a && (o = i), (S = x.nextSibling) !== null) break;
                x = g, g = x.parentNode;
              }
              x = S;
            }
            e = f === -1 || o === -1 ? null : { start: f, end: o };
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
                  var q = Ve(
                    e.type,
                    u
                  );
                  l = a.getSnapshotBeforeUpdate(
                    q,
                    n
                  ), a.__reactInternalSnapshotBeforeUpdate = l;
                } catch (Q) {
                  sl(
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
              if ((l & 1024) !== 0) throw Error(r(163));
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
        Wt(l, e), a & 4 && hd(l, e), a & 64 && (l = e.memoizedState, l !== null && (l = l.dehydrated, l !== null && (e = Nh.bind(
          null,
          e
        ), wh(l, e))));
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
  var Sl = null, Fl = !1;
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
        var a = Sl, u = Fl;
        pe(e.type) && (Sl = e.stateNode, Fl = !1), $t(
          l,
          t,
          e
        ), Au(e.stateNode), Sl = a, Fl = u;
        break;
      case 5:
        Dl || Rt(e, t);
      case 6:
        if (a = Sl, u = Fl, Sl = null, $t(
          l,
          t,
          e
        ), Sl = a, Fl = u, Sl !== null)
          if (Fl)
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
        Sl !== null && (Fl ? (l = Sl, ur(
          l.nodeType === 9 ? l.body : l.nodeName === "HTML" ? l.ownerDocument.body : l,
          e.stateNode
        ), Ra(l)) : ur(Sl, e.stateNode));
        break;
      case 4:
        a = Sl, u = Fl, Sl = e.stateNode.containerInfo, Fl = !0, $t(
          l,
          t,
          e
        ), Sl = a, Fl = u;
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
  function Sh(l) {
    switch (l.tag) {
      case 31:
      case 13:
      case 19:
        var t = l.stateNode;
        return t === null && (t = l.stateNode = new sd()), t;
      case 22:
        return l = l.stateNode, t = l._retryCache, t === null && (t = l._retryCache = new sd()), t;
      default:
        throw Error(r(435, l.tag));
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
  function Il(l, t) {
    var e = t.deletions;
    if (e !== null)
      for (var a = 0; a < e.length; a++) {
        var u = e[a], n = l, i = t, f = i;
        l: for (; f !== null; ) {
          switch (f.tag) {
            case 27:
              if (pe(f.type)) {
                Sl = f.stateNode, Fl = !1;
                break l;
              }
              break;
            case 5:
              Sl = f.stateNode, Fl = !1;
              break l;
            case 3:
            case 4:
              Sl = f.stateNode.containerInfo, Fl = !0;
              break l;
          }
          f = f.return;
        }
        if (Sl === null) throw Error(r(160));
        rd(n, i, u), Sl = null, Fl = !1, n = u.alternate, n !== null && (n.return = null), u.return = null;
      }
    if (t.subtreeFlags & 13886)
      for (t = t.child; t !== null; )
        vd(t, l), t = t.sibling;
  }
  var Ot = null;
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
        var u = Ot;
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
                      )), Ql(n, a, e), n[Bl] = l, Hl(n), a = n;
                      break l;
                    case "link":
                      var i = vr(
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
                      n = u.createElement(a), Ql(n, a, e), u.head.appendChild(n);
                      break;
                    case "meta":
                      if (i = vr(
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
                      n = u.createElement(a), Ql(n, a, e), u.head.appendChild(n);
                      break;
                    default:
                      throw Error(r(468, a));
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
          } catch (q) {
            sl(l, l.return, q);
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
            throw Error(r(162));
          a = l.memoizedProps, e = l.stateNode;
          try {
            e.nodeValue = a;
          } catch (q) {
            sl(l, l.return, q);
          }
        }
        break;
      case 3:
        if (Ln = null, u = Ot, Ot = Yn(t.containerInfo), Il(t, l), Ot = u, Pl(l), a & 4 && e !== null && e.memoizedState.isDehydrated)
          try {
            Ra(t.containerInfo);
          } catch (q) {
            sl(l, l.return, q);
          }
        Hc && (Hc = !1, yd(l));
        break;
      case 4:
        a = Ot, Ot = Yn(
          l.stateNode.containerInfo
        ), Il(t, l), Pl(l), Ot = a;
        break;
      case 12:
        Il(t, l), Pl(l);
        break;
      case 31:
        Il(t, l), Pl(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
        break;
      case 13:
        Il(t, l), Pl(l), l.child.flags & 8192 && l.memoizedState !== null != (e !== null && e.memoizedState !== null) && (En = ut()), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
        break;
      case 22:
        u = l.memoizedState !== null;
        var o = e !== null && e.memoizedState !== null, y = wt, A = Dl;
        if (wt = y || u, Dl = A || o, Il(t, l), Dl = A, wt = y, Pl(l), a & 8192)
          l: for (t = l.stateNode, t._visibility = u ? t._visibility & -2 : t._visibility | 1, u && (e === null || o || wt || Dl || Ke(l)), e = null, t = l; ; ) {
            if (t.tag === 5 || t.tag === 26) {
              if (e === null) {
                o = e = t;
                try {
                  if (n = o.stateNode, u)
                    i = n.style, typeof i.setProperty == "function" ? i.setProperty("display", "none", "important") : i.display = "none";
                  else {
                    f = o.stateNode;
                    var x = o.memoizedProps.style, g = x != null && x.hasOwnProperty("display") ? x.display : null;
                    f.style.display = g == null || typeof g == "boolean" ? "" : ("" + g).trim();
                  }
                } catch (q) {
                  sl(o, o.return, q);
                }
              }
            } else if (t.tag === 6) {
              if (e === null) {
                o = t;
                try {
                  o.stateNode.nodeValue = u ? "" : o.memoizedProps;
                } catch (q) {
                  sl(o, o.return, q);
                }
              }
            } else if (t.tag === 18) {
              if (e === null) {
                o = t;
                try {
                  var S = o.stateNode;
                  u ? nr(S, !0) : nr(o.stateNode, !1);
                } catch (q) {
                  sl(o, o.return, q);
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
        Il(t, l), Pl(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
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
        if (e == null) throw Error(r(160));
        switch (e.tag) {
          case 27:
            var u = e.stateNode, n = Rc(l);
            zn(l, n, u);
            break;
          case 5:
            var i = e.stateNode;
            e.flags & 32 && (ea(i, ""), e.flags &= -33);
            var f = Rc(l);
            zn(l, f, i);
            break;
          case 3:
          case 4:
            var o = e.stateNode.containerInfo, y = Rc(l);
            Cc(
              l,
              y,
              o
            );
            break;
          default:
            throw Error(r(161));
        }
      } catch (A) {
        sl(l, l.return, A);
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
            var f = a.stateNode;
            try {
              var o = u.shared.hiddenCallbacks;
              if (o !== null)
                for (u.shared.hiddenCallbacks = null, u = 0; u < o.length; u++)
                  Js(o[u], f);
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
  function _t(l, t, e, a) {
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
        _t(
          l,
          t,
          e,
          a
        ), u & 2048 && du(9, t);
        break;
      case 1:
        _t(
          l,
          t,
          e,
          a
        );
        break;
      case 3:
        _t(
          l,
          t,
          e,
          a
        ), u & 2048 && (l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Ia(l)));
        break;
      case 12:
        if (u & 2048) {
          _t(
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
          } catch (o) {
            sl(t, t.return, o);
          }
        } else
          _t(
            l,
            t,
            e,
            a
          );
        break;
      case 31:
        _t(
          l,
          t,
          e,
          a
        );
        break;
      case 13:
        _t(
          l,
          t,
          e,
          a
        );
        break;
      case 23:
        break;
      case 22:
        n = t.stateNode, i = t.alternate, t.memoizedState !== null ? n._visibility & 2 ? _t(
          l,
          t,
          e,
          a
        ) : mu(l, t) : n._visibility & 2 ? _t(
          l,
          t,
          e,
          a
        ) : (n._visibility |= 2, ja(
          l,
          t,
          e,
          a,
          (t.subtreeFlags & 10256) !== 0 || !1
        )), u & 2048 && qc(i, t);
        break;
      case 24:
        _t(
          l,
          t,
          e,
          a
        ), u & 2048 && Bc(t.alternate, t);
        break;
      default:
        _t(
          l,
          t,
          e,
          a
        );
    }
  }
  function ja(l, t, e, a, u) {
    for (u = u && ((t.subtreeFlags & 10256) !== 0 || !1), t = t.child; t !== null; ) {
      var n = l, i = t, f = e, o = a, y = i.flags;
      switch (i.tag) {
        case 0:
        case 11:
        case 15:
          ja(
            n,
            i,
            f,
            o,
            u
          ), du(8, i);
          break;
        case 23:
          break;
        case 22:
          var A = i.stateNode;
          i.memoizedState !== null ? A._visibility & 2 ? ja(
            n,
            i,
            f,
            o,
            u
          ) : mu(
            n,
            i
          ) : (A._visibility |= 2, ja(
            n,
            i,
            f,
            o,
            u
          )), u && y & 2048 && qc(
            i.alternate,
            i
          );
          break;
        case 24:
          ja(
            n,
            i,
            f,
            o,
            u
          ), u && y & 2048 && Bc(i.alternate, i);
          break;
        default:
          ja(
            n,
            i,
            f,
            o,
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
  function za(l, t, e) {
    if (l.subtreeFlags & hu)
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
        ), l.flags & hu && l.memoizedState !== null && nv(
          e,
          Ot,
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
        var a = Ot;
        Ot = Yn(l.stateNode.containerInfo), za(
          l,
          t,
          e
        ), Ot = a;
        break;
      case 22:
        l.memoizedState === null && (a = l.alternate, a !== null && a.memoizedState !== null ? (a = hu, hu = 16777216, za(
          l,
          t,
          e
        ), hu = a) : za(
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
  function Sd(l) {
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
      Sd(l);
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
        l.memoizedState !== null && t._visibility & 2 && (l.return === null || l.return.tag !== 13) ? (t._visibility &= -3, xn(l)) : vu(l);
        break;
      default:
        vu(l);
    }
  }
  function xn(l) {
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
      Sd(l);
    }
    for (l = l.child; l !== null; ) {
      switch (t = l, t.tag) {
        case 0:
        case 11:
        case 15:
          me(8, t, t.return), xn(t);
          break;
        case 22:
          e = t.stateNode, e._visibility & 2 && (e._visibility &= -3, xn(t));
          break;
        default:
          xn(t);
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
  var ph = {
    getCacheForType: function(l) {
      var t = Gl(Ol), e = t.data.get(l);
      return e === void 0 && (e = l(), t.data.set(l, e)), e;
    },
    cacheSignal: function() {
      return Gl(Ol).controller.signal;
    }
  }, Ah = typeof WeakMap == "function" ? WeakMap : Map, nl = 0, vl = null, F = null, P = 0, fl = 0, dt = null, he = !1, Ta = !1, Yc = !1, Ft = 0, Al = 0, ve = 0, Je = 0, Gc = 0, rt = 0, xa = 0, yu = null, lt = null, Lc = !1, En = 0, jd = 0, Nn = 1 / 0, On = null, ye = null, Ul = 0, ge = null, Ea = null, It = 0, Qc = 0, Xc = null, zd = null, gu = 0, Zc = null;
  function mt() {
    return (nl & 2) !== 0 && P !== 0 ? P & -P : z.T !== null ? Wc() : Yf();
  }
  function Td() {
    if (rt === 0)
      if ((P & 536870912) === 0 || el) {
        var l = Hu;
        Hu <<= 1, (Hu & 3932160) === 0 && (Hu = 262144), rt = l;
      } else rt = 536870912;
    return l = st.current, l !== null && (l.flags |= 32), rt;
  }
  function tt(l, t, e) {
    (l === vl && (fl === 2 || fl === 9) || l.cancelPendingCommit !== null) && (Na(l, 0), be(
      l,
      P,
      rt,
      !1
    )), Ya(l, e), ((nl & 2) === 0 || l !== vl) && (l === vl && ((nl & 2) === 0 && (Je |= e), Al === 4 && be(
      l,
      P,
      rt,
      !1
    )), Ct(l));
  }
  function xd(l, t, e) {
    if ((nl & 6) !== 0) throw Error(r(327));
    var a = !e && (t & 127) === 0 && (t & l.expiredLanes) === 0 || Ba(l, t), u = a ? Th(l, t) : Kc(l, t, !0), n = a;
    do {
      if (u === 0) {
        Ta && !a && be(l, t, 0, !1);
        break;
      } else {
        if (e = l.current.alternate, n && !jh(e)) {
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
              var f = l;
              u = yu;
              var o = f.current.memoizedState.isDehydrated;
              if (o && (Na(f, i).flags |= 256), i = Kc(
                f,
                i,
                !1
              ), i !== 2) {
                if (Yc && !o) {
                  f.errorRecoveryDisabledLanes |= n, Je |= n, u = 4;
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
          Na(l, 0), be(l, t, 0, !0);
          break;
        }
        l: {
          switch (a = l, n = u, n) {
            case 0:
            case 1:
              throw Error(r(345));
            case 4:
              if ((t & 4194048) !== t) break;
            case 6:
              be(
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
              throw Error(r(329));
          }
          if ((t & 62914560) === t && (u = En + 300 - ut(), 10 < u)) {
            if (be(
              a,
              t,
              rt,
              !he
            ), Bu(a, 0, !0) !== 0) break l;
            It = t, a.timeoutHandle = er(
              Ed.bind(
                null,
                a,
                e,
                lt,
                On,
                Lc,
                t,
                rt,
                Je,
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
          Ed(
            a,
            e,
            lt,
            On,
            Lc,
            t,
            rt,
            Je,
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
    Ct(l);
  }
  function Ed(l, t, e, a, u, n, i, f, o, y, A, x, g, S) {
    if (l.timeoutHandle = -1, x = t.subtreeFlags, x & 8192 || (x & 16785408) === 16785408) {
      x = {
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
        x
      );
      var q = (n & 62914560) === n ? En - ut() : (n & 4194048) === n ? jd - ut() : 0;
      if (q = iv(
        x,
        q
      ), q !== null) {
        It = n, l.cancelPendingCommit = q(
          Cd.bind(
            null,
            l,
            t,
            n,
            e,
            a,
            u,
            i,
            f,
            o,
            A,
            x,
            null,
            g,
            S
          )
        ), be(l, n, i, !y);
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
      f,
      o
    );
  }
  function jh(l) {
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
  function be(l, t, e, a) {
    t &= ~Gc, t &= ~Je, l.suspendedLanes |= t, l.pingedLanes &= ~t, a && (l.warmLanes |= t), a = l.expirationTimes;
    for (var u = t; 0 < u; ) {
      var n = 31 - it(u), i = 1 << n;
      a[n] = -1, u &= ~i;
    }
    e !== 0 && Hf(l, e, t);
  }
  function _n() {
    return (nl & 6) === 0 ? (bu(0), !1) : !0;
  }
  function Vc() {
    if (F !== null) {
      if (fl === 0)
        var l = F.return;
      else
        l = F, Qt = Be = null, ic(l), ga = null, lu = 0, l = F;
      for (; l !== null; )
        ad(l.alternate, l), l = l.return;
      F = null;
    }
  }
  function Na(l, t) {
    var e = l.timeoutHandle;
    e !== -1 && (l.timeoutHandle = -1, Xh(e)), e = l.cancelPendingCommit, e !== null && (l.cancelPendingCommit = null, e()), It = 0, Vc(), vl = l, F = e = Gt(l.current, null), P = t, fl = 0, dt = null, he = !1, Ta = Ba(l, t), Yc = !1, xa = rt = Gc = Je = ve = Al = 0, lt = yu = null, Lc = !1, (t & 8) !== 0 && (t |= t & 32);
    var a = l.entangledLanes;
    if (a !== 0)
      for (l = l.entanglements, a &= t; 0 < a; ) {
        var u = 31 - it(a), n = 1 << u;
        t |= l[u], a &= ~n;
      }
    return Ft = t, Wu(), e;
  }
  function Nd(l, t) {
    w = null, z.H = fu, t === ya || t === an ? (t = Xs(), fl = 3) : t === $i ? (t = Xs(), fl = 4) : fl = t === jc ? 8 : t !== null && typeof t == "object" && typeof t.then == "function" ? 6 : 1, dt = t, F === null && (Al = 1, bn(
      l,
      bt(t, l.current)
    ));
  }
  function Od() {
    var l = st.current;
    return l === null ? !0 : (P & 4194048) === P ? jt === null : (P & 62914560) === P || (P & 536870912) !== 0 ? l === jt : !1;
  }
  function _d() {
    var l = z.H;
    return z.H = fu, l === null ? fu : l;
  }
  function Md() {
    var l = z.A;
    return z.A = ph, l;
  }
  function Mn() {
    Al = 4, he || (P & 4194048) !== P && st.current !== null || (Ta = !0), (ve & 134217727) === 0 && (Je & 134217727) === 0 || vl === null || be(
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
          var f = F, o = dt;
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
              if (fl = 0, dt = null, Oa(l, f, o, y), e && Ta) {
                i = 0;
                break l;
              }
              break;
            default:
              y = fl, fl = 0, dt = null, Oa(l, f, o, y);
          }
        }
        zh(), i = Al;
        break;
      } catch (A) {
        Nd(l, A);
      }
    while (!0);
    return t && l.shellSuspendCounter++, Qt = Be = null, nl = a, z.H = u, z.A = n, F === null && (vl = null, P = 0, Wu()), i;
  }
  function zh() {
    for (; F !== null; ) Dd(F);
  }
  function Th(l, t) {
    var e = nl;
    nl |= 2;
    var a = _d(), u = Md();
    vl !== l || P !== t ? (On = null, Nn = ut() + 500, Na(l, t)) : Ta = Ba(
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
                  var f = F;
                  if (i ? gr(i) : f.stateNode.complete) {
                    fl = 0, dt = null;
                    var o = f.sibling;
                    if (o !== null) F = o;
                    else {
                      var y = f.return;
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
              throw Error(r(462));
          }
        }
        xh();
        break;
      } catch (A) {
        Nd(l, A);
      }
    while (!0);
    return Qt = Be = null, z.H = a, z.A = u, nl = e, F !== null ? 0 : (vl = null, P = 0, Wu(), Al);
  }
  function xh() {
    for (; F !== null && !$r(); )
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
    Qt = Be = null, ic(t), ga = null, lu = 0;
    var u = t.return;
    try {
      if (mh(
        l,
        u,
        t,
        e,
        P
      )) {
        Al = 1, bn(
          l,
          bt(e, l.current)
        ), F = null;
        return;
      }
    } catch (n) {
      if (u !== null) throw F = u, n;
      Al = 1, bn(
        l,
        bt(e, l.current)
      ), F = null;
      return;
    }
    t.flags & 32768 ? (el || a === 1 ? l = !0 : Ta || (P & 536870912) !== 0 ? l = !1 : (he = l = !0, (a === 2 || a === 9 || a === 3 || a === 6) && (a = st.current, a !== null && a.tag === 13 && (a.flags |= 16384))), Rd(t, l)) : Dn(t);
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
    Al === 0 && (Al = 5);
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
    Al = 6, F = null;
  }
  function Cd(l, t, e, a, u, n, i, f, o) {
    l.cancelPendingCommit = null;
    do
      Un();
    while (Ul !== 0);
    if ((nl & 6) !== 0) throw Error(r(327));
    if (t !== null) {
      if (t === l.current) throw Error(r(177));
      if (n = t.lanes | t.childLanes, n |= Ri, um(
        l,
        e,
        n,
        i,
        f,
        o
      ), l === vl && (F = vl = null, P = 0), Ea = t, ge = l, It = e, Qc = n, Xc = u, zd = a, (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? (l.callbackNode = null, l.callbackPriority = 0, _h(Ru, function() {
        return Gd(), null;
      })) : (l.callbackNode = null, l.callbackPriority = 0), a = (t.flags & 13878) !== 0, (t.subtreeFlags & 13878) !== 0 || a) {
        a = z.T, z.T = null, u = U.p, U.p = 2, i = nl, nl |= 4;
        try {
          bh(l, t, e);
        } finally {
          nl = i, U.p = u, z.T = a;
        }
      }
      Ul = 1, Hd(), qd(), Bd();
    }
  }
  function Hd() {
    if (Ul === 1) {
      Ul = 0;
      var l = ge, t = Ea, e = (t.flags & 13878) !== 0;
      if ((t.subtreeFlags & 13878) !== 0 || e) {
        e = z.T, z.T = null;
        var a = U.p;
        U.p = 2;
        var u = nl;
        nl |= 4;
        try {
          vd(t, l);
          var n = af, i = ps(l.containerInfo), f = n.focusedElem, o = n.selectionRange;
          if (i !== f && f && f.ownerDocument && Ss(
            f.ownerDocument.documentElement,
            f
          )) {
            if (o !== null && Oi(f)) {
              var y = o.start, A = o.end;
              if (A === void 0 && (A = y), "selectionStart" in f)
                f.selectionStart = y, f.selectionEnd = Math.min(
                  A,
                  f.value.length
                );
              else {
                var x = f.ownerDocument || document, g = x && x.defaultView || window;
                if (g.getSelection) {
                  var S = g.getSelection(), q = f.textContent.length, Q = Math.min(o.start, q), ml = o.end === void 0 ? Q : Math.min(o.end, q);
                  !S.extend && Q > ml && (i = ml, ml = Q, Q = i);
                  var h = bs(
                    f,
                    Q
                  ), d = bs(
                    f,
                    ml
                  );
                  if (h && d && (S.rangeCount !== 1 || S.anchorNode !== h.node || S.anchorOffset !== h.offset || S.focusNode !== d.node || S.focusOffset !== d.offset)) {
                    var v = x.createRange();
                    v.setStart(h.node, h.offset), S.removeAllRanges(), Q > ml ? (S.addRange(v), S.extend(d.node, d.offset)) : (v.setEnd(d.node, d.offset), S.addRange(v));
                  }
                }
              }
            }
            for (x = [], S = f; S = S.parentNode; )
              S.nodeType === 1 && x.push({
                element: S,
                left: S.scrollLeft,
                top: S.scrollTop
              });
            for (typeof f.focus == "function" && f.focus(), f = 0; f < x.length; f++) {
              var T = x[f];
              T.element.scrollLeft = T.left, T.element.scrollTop = T.top;
            }
          }
          Vn = !!ef, af = ef = null;
        } finally {
          nl = u, U.p = a, z.T = e;
        }
      }
      l.current = t, Ul = 2;
    }
  }
  function qd() {
    if (Ul === 2) {
      Ul = 0;
      var l = ge, t = Ea, e = (t.flags & 8772) !== 0;
      if ((t.subtreeFlags & 8772) !== 0 || e) {
        e = z.T, z.T = null;
        var a = U.p;
        U.p = 2;
        var u = nl;
        nl |= 4;
        try {
          od(l, t.alternate, t);
        } finally {
          nl = u, U.p = a, z.T = e;
        }
      }
      Ul = 3;
    }
  }
  function Bd() {
    if (Ul === 4 || Ul === 3) {
      Ul = 0, Wr();
      var l = ge, t = Ea, e = It, a = zd;
      (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? Ul = 5 : (Ul = 0, Ea = ge = null, Yd(l, l.pendingLanes));
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
        t = z.T, u = U.p, U.p = 2, z.T = null;
        try {
          for (var n = l.onRecoverableError, i = 0; i < a.length; i++) {
            var f = a[i];
            n(f.value, {
              componentStack: f.stack
            });
          }
        } finally {
          z.T = t, U.p = u;
        }
      }
      (It & 3) !== 0 && Un(), Ct(l), u = l.pendingLanes, (e & 261930) !== 0 && (u & 42) !== 0 ? l === Zc ? gu++ : (gu = 0, Zc = l) : gu = 0, bu(0);
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
    var l = ge, t = Qc;
    Qc = 0;
    var e = si(It), a = z.T, u = U.p;
    try {
      U.p = 32 > e ? 32 : e, z.T = null, e = Xc, Xc = null;
      var n = ge, i = It;
      if (Ul = 0, Ea = ge = null, It = 0, (nl & 6) !== 0) throw Error(r(331));
      var f = nl;
      if (nl |= 4, pd(n.current), gd(
        n,
        n.current,
        i,
        e
      ), nl = f, bu(0, !1), nt && typeof nt.onPostCommitFiberRoot == "function")
        try {
          nt.onPostCommitFiberRoot(qa, n);
        } catch {
        }
      return !0;
    } finally {
      U.p = u, z.T = a, Yd(l, t);
    }
  }
  function Ld(l, t, e) {
    t = bt(e, t), t = Ac(l.stateNode, t, 2), l = oe(l, t, 2), l !== null && (Ya(l, 2), Ct(l));
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
            l = bt(e, l), e = Qo(2), a = oe(t, e, 2), a !== null && (Xo(
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
      a = l.pingCache = new Ah();
      var u = /* @__PURE__ */ new Set();
      a.set(t, u);
    } else
      u = a.get(t), u === void 0 && (u = /* @__PURE__ */ new Set(), a.set(t, u));
    u.has(e) || (Yc = !0, u.add(e), l = Eh.bind(null, l, t, e), t.then(l, l));
  }
  function Eh(l, t, e) {
    var a = l.pingCache;
    a !== null && a.delete(t), l.pingedLanes |= l.suspendedLanes & e, l.warmLanes &= ~e, vl === l && (P & e) === e && (Al === 4 || Al === 3 && (P & 62914560) === P && 300 > ut() - En ? (nl & 2) === 0 && Na(l, 0) : Gc |= e, xa === P && (xa = 0)), Ct(l);
  }
  function Qd(l, t) {
    t === 0 && (t = Cf()), l = Ce(l, t), l !== null && (Ya(l, t), Ct(l));
  }
  function Nh(l) {
    var t = l.memoizedState, e = 0;
    t !== null && (e = t.retryLane), Qd(l, e);
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
        throw Error(r(314));
    }
    a !== null && a.delete(t), Qd(l, e);
  }
  function _h(l, t) {
    return ni(l, t);
  }
  var Rn = null, _a = null, wc = !1, Cn = !1, $c = !1, Se = 0;
  function Ct(l) {
    l !== _a && l.next === null && (_a === null ? Rn = _a = l : _a = _a.next = l), Cn = !0, wc || (wc = !0, Dh());
  }
  function bu(l, t) {
    if (!$c && Cn) {
      $c = !0;
      do
        for (var e = !1, a = Rn; a !== null; ) {
          if (l !== 0) {
            var u = a.pendingLanes;
            if (u === 0) var n = 0;
            else {
              var i = a.suspendedLanes, f = a.pingedLanes;
              n = (1 << 31 - it(42 | l) + 1) - 1, n &= u & ~(i & ~f), n = n & 201326741 ? n & 201326741 | 1 : n ? n | 2 : 0;
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
  function Mh() {
    Xd();
  }
  function Xd() {
    Cn = wc = !1;
    var l = 0;
    Se !== 0 && Qh() && (l = Se);
    for (var t = ut(), e = null, a = Rn; a !== null; ) {
      var u = a.next, n = Zd(a, t);
      n === 0 ? (a.next = null, e === null ? Rn = u : e.next = u, u === null && (_a = e)) : (e = a, (l !== 0 || (n & 3) !== 0) && (Cn = !0)), a = u;
    }
    Ul !== 0 && Ul !== 5 || bu(l), Se !== 0 && (Se = 0);
  }
  function Zd(l, t) {
    for (var e = l.suspendedLanes, a = l.pingedLanes, u = l.expirationTimes, n = l.pendingLanes & -62914561; 0 < n; ) {
      var i = 31 - it(n), f = 1 << i, o = u[i];
      o === -1 ? ((f & e) === 0 || (f & a) !== 0) && (u[i] = am(f, t)) : o <= t && (l.expiredLanes |= f), n &= ~f;
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
    ), a === 0 ? null : (xd(l, a, t), Zd(l, ut()), l.callbackNode != null && l.callbackNode === e ? Vd.bind(null, l) : null);
  }
  function Kd(l, t) {
    if (Un()) return null;
    xd(l, t, !0);
  }
  function Dh() {
    Zh(function() {
      (nl & 6) !== 0 ? ni(
        Df,
        Mh
      ) : Xd();
    });
  }
  function Wc() {
    if (Se === 0) {
      var l = ha;
      l === 0 && (l = Cu, Cu <<= 1, (Cu & 261888) === 0 && (Cu = 256)), Se = l;
    }
    return Se;
  }
  function Jd(l) {
    return l == null || typeof l == "symbol" || typeof l == "boolean" ? null : typeof l == "function" ? l : Qu("" + l);
  }
  function wd(l, t) {
    var e = t.ownerDocument.createElement("input");
    return e.name = t.name, e.value = t.value, l.id && e.setAttribute("form", l.id), t.parentNode.insertBefore(e, t), l = new FormData(l), e.parentNode.removeChild(e), l;
  }
  function Uh(l, t, e, a, u) {
    if (t === "submit" && e && e.stateNode === u) {
      var n = Jd(
        (u[Wl] || null).action
      ), i = a.submitter;
      i && (t = (t = i[Wl] || null) ? Jd(t.formAction) : i.getAttribute("formAction"), t !== null && (n = t, i = null));
      var f = new Ku(
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
                if (Se !== 0) {
                  var o = i ? wd(u, i) : new FormData(u);
                  vc(
                    e,
                    {
                      pending: !0,
                      data: o,
                      method: u.method,
                      action: n
                    },
                    null,
                    o
                  );
                }
              } else
                typeof n == "function" && (f.preventDefault(), o = i ? wd(u, i) : new FormData(u), vc(
                  e,
                  {
                    pending: !0,
                    data: o,
                    method: u.method,
                    action: n
                  },
                  n,
                  o
                ));
            },
            currentTarget: u
          }
        ]
      });
    }
  }
  for (var kc = 0; kc < Ui.length; kc++) {
    var Fc = Ui[kc], Rh = Fc.toLowerCase(), Ch = Fc[0].toUpperCase() + Fc.slice(1);
    Nt(
      Rh,
      "on" + Ch
    );
  }
  Nt(zs, "onAnimationEnd"), Nt(Ts, "onAnimationIteration"), Nt(xs, "onAnimationStart"), Nt("dblclick", "onDoubleClick"), Nt("focusin", "onFocus"), Nt("focusout", "onBlur"), Nt(km, "onTransitionRun"), Nt(Fm, "onTransitionStart"), Nt(Im, "onTransitionCancel"), Nt(Es, "onTransitionEnd"), la("onMouseEnter", ["mouseout", "mouseover"]), la("onMouseLeave", ["mouseout", "mouseover"]), la("onPointerEnter", ["pointerout", "pointerover"]), la("onPointerLeave", ["pointerout", "pointerover"]), Me(
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
  var Su = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
    " "
  ), Hh = new Set(
    "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(Su)
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
            var f = a[i], o = f.instance, y = f.currentTarget;
            if (f = f.listener, o !== n && u.isPropagationStopped())
              break l;
            n = f, u.currentTarget = y;
            try {
              n(u);
            } catch (A) {
              $u(A);
            }
            u.currentTarget = null, n = o;
          }
        else
          for (i = 0; i < a.length; i++) {
            if (f = a[i], o = f.instance, y = f.currentTarget, f = f.listener, o !== n && u.isPropagationStopped())
              break l;
            n = f, u.currentTarget = y;
            try {
              n(u);
            } catch (A) {
              $u(A);
            }
            u.currentTarget = null, n = o;
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
      l[Hn] = !0, Qf.forEach(function(e) {
        e !== "selectionchange" && (Hh.has(e) || Ic(e, !1, l), Ic(e, !0, l));
      });
      var t = l.nodeType === 9 ? l : l.ownerDocument;
      t === null || t[Hn] || (t[Hn] = !0, Ic("selectionchange", !1, t));
    }
  }
  function Wd(l, t, e, a) {
    switch (Tr(t)) {
      case 2:
        var u = sv;
        break;
      case 8:
        u = ov;
        break;
      default:
        u = vf;
    }
    e = u.bind(
      null,
      t,
      e,
      l
    ), u = void 0, !Si || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (u = !0), a ? u !== void 0 ? l.addEventListener(t, e, {
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
          var f = a.stateNode.containerInfo;
          if (f === u) break;
          if (i === 4)
            for (i = a.return; i !== null; ) {
              var o = i.tag;
              if ((o === 3 || o === 4) && i.stateNode.containerInfo === u)
                return;
              i = i.return;
            }
          for (; f !== null; ) {
            if (i = Fe(f), i === null) return;
            if (o = i.tag, o === 5 || o === 6 || o === 26 || o === 27) {
              a = n = i;
              continue l;
            }
            f = f.parentNode;
          }
        }
        a = a.return;
      }
    Pf(function() {
      var y = n, A = gi(e), x = [];
      l: {
        var g = Ns.get(l);
        if (g !== void 0) {
          var S = Ku, q = l;
          switch (l) {
            case "keypress":
              if (Zu(e) === 0) break l;
            case "keydown":
            case "keyup":
              S = Om;
              break;
            case "focusin":
              q = "focus", S = zi;
              break;
            case "focusout":
              q = "blur", S = zi;
              break;
            case "beforeblur":
            case "afterblur":
              S = zi;
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
              S = ym;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              S = Dm;
              break;
            case zs:
            case Ts:
            case xs:
              S = Sm;
              break;
            case Es:
              S = Rm;
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
              S = Am;
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
              S = Bm;
          }
          var Q = (t & 4) !== 0, ml = !Q && (l === "scroll" || l === "scrollend"), h = Q ? g !== null ? g + "Capture" : null : g;
          Q = [];
          for (var d = y, v; d !== null; ) {
            var T = d;
            if (v = T.stateNode, T = T.tag, T !== 5 && T !== 26 && T !== 27 || v === null || h === null || (T = Qa(d, h), T != null && Q.push(
              pu(d, T, v)
            )), ml) break;
            d = d.return;
          }
          0 < Q.length && (g = new S(
            g,
            q,
            null,
            e,
            A
          ), x.push({ event: g, listeners: Q }));
        }
      }
      if ((t & 7) === 0) {
        l: {
          if (g = l === "mouseover" || l === "pointerover", S = l === "mouseout" || l === "pointerout", g && e !== yi && (q = e.relatedTarget || e.fromElement) && (Fe(q) || q[ke]))
            break l;
          if ((S || g) && (g = A.window === A ? A : (g = A.ownerDocument) ? g.defaultView || g.parentWindow : window, S ? (q = e.relatedTarget || e.toElement, S = y, q = q ? Fe(q) : null, q !== null && (ml = D(q), Q = q.tag, q !== ml || Q !== 5 && Q !== 27 && Q !== 6) && (q = null)) : (S = null, q = y), S !== q)) {
            if (Q = es, T = "onMouseLeave", h = "onMouseEnter", d = "mouse", (l === "pointerout" || l === "pointerover") && (Q = us, T = "onPointerLeave", h = "onPointerEnter", d = "pointer"), ml = S == null ? g : La(S), v = q == null ? g : La(q), g = new Q(
              T,
              d + "leave",
              S,
              e,
              A
            ), g.target = ml, g.relatedTarget = v, T = null, Fe(A) === y && (Q = new Q(
              h,
              d + "enter",
              q,
              e,
              A
            ), Q.target = v, Q.relatedTarget = ml, T = Q), ml = T, S && q)
              t: {
                for (Q = qh, h = S, d = q, v = 0, T = h; T; T = Q(T))
                  v++;
                T = 0;
                for (var G = d; G; G = Q(G))
                  T++;
                for (; 0 < v - T; )
                  h = Q(h), v--;
                for (; 0 < T - v; )
                  d = Q(d), T--;
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
            S !== null && kd(
              x,
              g,
              S,
              Q,
              !1
            ), q !== null && ml !== null && kd(
              x,
              ml,
              q,
              Q,
              !0
            );
          }
        }
        l: {
          if (g = y ? La(y) : window, S = g.nodeName && g.nodeName.toLowerCase(), S === "select" || S === "input" && g.type === "file")
            var al = rs;
          else if (os(g))
            if (ms)
              al = wm;
            else {
              al = Km;
              var Y = Vm;
            }
          else
            S = g.nodeName, !S || S.toLowerCase() !== "input" || g.type !== "checkbox" && g.type !== "radio" ? y && vi(y.elementType) && (al = rs) : al = Jm;
          if (al && (al = al(l, y))) {
            ds(
              x,
              al,
              e,
              A
            );
            break l;
          }
          Y && Y(l, g, y), l === "focusout" && y && g.type === "number" && y.memoizedProps.value != null && hi(g, "number", g.value);
        }
        switch (Y = y ? La(y) : window, l) {
          case "focusin":
            (os(Y) || Y.contentEditable === "true") && (ia = Y, _i = y, Wa = null);
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
            Mi = !1, As(x, e, A);
            break;
          case "selectionchange":
            if (Wm) break;
          case "keydown":
          case "keyup":
            As(x, e, A);
        }
        var W;
        if (xi)
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
        ll && (ns && e.locale !== "ko" && (na || ll !== "onCompositionStart" ? ll === "onCompositionEnd" && na && (W = ls()) : (ae = A, pi = "value" in ae ? ae.value : ae.textContent, na = !0)), Y = qn(y, ll), 0 < Y.length && (ll = new as(
          ll,
          l,
          null,
          e,
          A
        ), x.push({ event: ll, listeners: Y }), W ? ll.data = W : (W = ss(e), W !== null && (ll.data = W)))), (W = Gm ? Lm(l, e) : Qm(l, e)) && (ll = qn(y, "onBeforeInput"), 0 < ll.length && (Y = new as(
          "onBeforeInput",
          "beforeinput",
          null,
          e,
          A
        ), x.push({
          event: Y,
          listeners: ll
        }), Y.data = W)), Uh(
          x,
          l,
          y,
          e,
          A
        );
      }
      $d(x, t);
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
      if (u = u.tag, u !== 5 && u !== 26 && u !== 27 || n === null || (u = Qa(l, e), u != null && a.unshift(
        pu(l, u, n)
      ), u = Qa(l, t), u != null && a.push(
        pu(l, u, n)
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
  function kd(l, t, e, a, u) {
    for (var n = t._reactName, i = []; e !== null && e !== a; ) {
      var f = e, o = f.alternate, y = f.stateNode;
      if (f = f.tag, o !== null && o === a) break;
      f !== 5 && f !== 26 && f !== 27 || y === null || (o = y, u ? (y = Qa(e, n), y != null && i.unshift(
        pu(e, y, o)
      )) : u || (y = Qa(e, n), y != null && i.push(
        pu(e, y, o)
      ))), e = e.return;
    }
    i.length !== 0 && l.push({ event: t, listeners: i });
  }
  var Bh = /\r\n?/g, Yh = /\u0000|\uFFFD/g;
  function Fd(l) {
    return (typeof l == "string" ? l : "" + l).replace(Bh, `
`).replace(Yh, "");
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
        a = Qu("" + a), l.setAttribute(e, a);
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
        a = Qu("" + a), l.setAttribute(e, a);
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
            throw Error(r(61));
          if (e = a.__html, e != null) {
            if (u.children != null) throw Error(r(60));
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
        e = Qu("" + a), l.setAttributeNS(
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
        (!(2 < e.length) || e[0] !== "o" && e[0] !== "O" || e[1] !== "n" && e[1] !== "N") && (e = rm.get(e) || e, Yu(l, e, a));
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
            throw Error(r(61));
          if (e = a.__html, e != null) {
            if (u.children != null) throw Error(r(60));
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
        if (!Xf.hasOwnProperty(e))
          l: {
            if (e[0] === "o" && e[1] === "n" && (u = e.endsWith("Capture"), t = e.slice(2, u ? e.length - 7 : void 0), n = l[Wl] || null, n = n != null ? n[e] : null, typeof n == "function" && l.removeEventListener(t, n, u), typeof a == "function")) {
              typeof n != "function" && n !== null && (e in l ? l[e] = null : l.hasAttribute(e) && l.removeAttribute(e)), l.addEventListener(t, a, u);
              break l;
            }
            e in l ? l[e] = a : a === !0 ? l.setAttribute(e, "") : Yu(l, e, a);
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
                  throw Error(r(137, t));
                default:
                  rl(l, t, n, i, e, null);
              }
          }
        u && rl(l, t, "srcSet", e.srcSet, e, null), a && rl(l, t, "src", e.src, e, null);
        return;
      case "input":
        I("invalid", l);
        var f = n = i = u = null, o = null, y = null;
        for (a in e)
          if (e.hasOwnProperty(a)) {
            var A = e[a];
            if (A != null)
              switch (a) {
                case "name":
                  u = A;
                  break;
                case "type":
                  i = A;
                  break;
                case "checked":
                  o = A;
                  break;
                case "defaultChecked":
                  y = A;
                  break;
                case "value":
                  n = A;
                  break;
                case "defaultValue":
                  f = A;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  if (A != null)
                    throw Error(r(137, t));
                  break;
                default:
                  rl(l, t, a, A, e, null);
              }
          }
        wf(
          l,
          n,
          f,
          o,
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
                rl(l, t, u, f, e, null);
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
                if (f != null) throw Error(r(91));
                break;
              default:
                rl(l, t, i, f, e, null);
            }
        Wf(l, a, u, n);
        return;
      case "option":
        for (o in e)
          e.hasOwnProperty(o) && (a = e[o], a != null) && (o === "selected" ? l.selected = a && typeof a != "function" && typeof a != "symbol" : rl(l, t, o, a, e, null));
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
        for (a = 0; a < Su.length; a++)
          I(Su[a], l);
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
                throw Error(r(137, t));
              default:
                rl(l, t, y, a, e, null);
            }
        return;
      default:
        if (vi(t)) {
          for (A in e)
            e.hasOwnProperty(A) && (a = e[A], a !== void 0 && tf(
              l,
              t,
              A,
              a,
              e,
              void 0
            ));
          return;
        }
    }
    for (f in e)
      e.hasOwnProperty(f) && (a = e[f], a != null && rl(l, t, f, a, e, null));
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
        var u = null, n = null, i = null, f = null, o = null, y = null, A = null;
        for (S in e) {
          var x = e[S];
          if (e.hasOwnProperty(S) && x != null)
            switch (S) {
              case "checked":
                break;
              case "value":
                break;
              case "defaultValue":
                o = x;
              default:
                a.hasOwnProperty(S) || rl(l, t, S, null, a, x);
            }
        }
        for (var g in a) {
          var S = a[g];
          if (x = e[g], a.hasOwnProperty(g) && (S != null || x != null))
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
                A = S;
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
                  throw Error(r(137, t));
                break;
              default:
                S !== x && rl(
                  l,
                  t,
                  g,
                  S,
                  a,
                  x
                );
            }
        }
        mi(
          l,
          i,
          f,
          o,
          y,
          A,
          n,
          u
        );
        return;
      case "select":
        S = i = f = g = null;
        for (n in e)
          if (o = e[n], e.hasOwnProperty(n) && o != null)
            switch (n) {
              case "value":
                break;
              case "multiple":
                S = o;
              default:
                a.hasOwnProperty(n) || rl(
                  l,
                  t,
                  n,
                  null,
                  a,
                  o
                );
            }
        for (u in a)
          if (n = a[u], o = e[u], a.hasOwnProperty(u) && (n != null || o != null))
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
                n !== o && rl(
                  l,
                  t,
                  u,
                  n,
                  a,
                  o
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
                rl(l, t, f, null, a, u);
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
                if (u != null) throw Error(r(91));
                break;
              default:
                u !== n && rl(l, t, i, u, a, n);
            }
        $f(l, g, S);
        return;
      case "option":
        for (var q in e)
          g = e[q], e.hasOwnProperty(q) && g != null && !a.hasOwnProperty(q) && (q === "selected" ? l.selected = !1 : rl(
            l,
            t,
            q,
            null,
            a,
            g
          ));
        for (o in a)
          g = a[o], S = e[o], a.hasOwnProperty(o) && g !== S && (g != null || S != null) && (o === "selected" ? l.selected = g && typeof g != "function" && typeof g != "symbol" : rl(
            l,
            t,
            o,
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
          g = e[Q], e.hasOwnProperty(Q) && g != null && !a.hasOwnProperty(Q) && rl(l, t, Q, null, a, g);
        for (y in a)
          if (g = a[y], S = e[y], a.hasOwnProperty(y) && g !== S && (g != null || S != null))
            switch (y) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (g != null)
                  throw Error(r(137, t));
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
          for (A in a)
            g = a[A], S = e[A], !a.hasOwnProperty(A) || g === S || g === void 0 && S === void 0 || tf(
              l,
              t,
              A,
              g,
              a,
              S
            );
          return;
        }
    }
    for (var h in e)
      g = e[h], e.hasOwnProperty(h) && g != null && !a.hasOwnProperty(h) && rl(l, t, h, null, a, g);
    for (x in a)
      g = a[x], S = e[x], !a.hasOwnProperty(x) || g === S || g == null && S == null || rl(l, t, x, g, a, S);
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
  function Lh() {
    if (typeof performance.getEntriesByType == "function") {
      for (var l = 0, t = 0, e = performance.getEntriesByType("resource"), a = 0; a < e.length; a++) {
        var u = e[a], n = u.transferSize, i = u.initiatorType, f = u.duration;
        if (n && f && Pd(i)) {
          for (i = 0, f = u.responseEnd, a += 1; a < e.length; a++) {
            var o = e[a], y = o.startTime;
            if (y > f) break;
            var A = o.transferSize, x = o.initiatorType;
            A && Pd(x) && (o = o.responseEnd, i += A * (o < f ? 1 : (f - y) / (o - y)));
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
  function Qh() {
    var l = window.event;
    return l && l.type === "popstate" ? l === nf ? !1 : (nf = l, !0) : (nf = null, !1);
  }
  var er = typeof setTimeout == "function" ? setTimeout : void 0, Xh = typeof clearTimeout == "function" ? clearTimeout : void 0, ar = typeof Promise == "function" ? Promise : void 0, Zh = typeof queueMicrotask == "function" ? queueMicrotask : typeof ar < "u" ? function(l) {
    return ar.resolve(null).then(l).catch(Vh);
  } : er;
  function Vh(l) {
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
            var i = n.nextSibling, f = n.nodeName;
            n[Ga] || f === "SCRIPT" || f === "STYLE" || f === "LINK" && n.rel.toLowerCase() === "stylesheet" || e.removeChild(n), n = i;
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
  function Kh(l, t, e, a) {
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
      if (l = zt(l.nextSibling), l === null) break;
    }
    return null;
  }
  function Jh(l, t, e) {
    if (t === "") return null;
    for (; l.nodeType !== 3; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !e || (l = zt(l.nextSibling), l === null)) return null;
    return l;
  }
  function ir(l, t) {
    for (; l.nodeType !== 8; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !t || (l = zt(l.nextSibling), l === null)) return null;
    return l;
  }
  function ff(l) {
    return l.data === "$?" || l.data === "$~";
  }
  function sf(l) {
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
  function zt(l) {
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
            return zt(l.nextSibling);
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
        if (l = t.documentElement, !l) throw Error(r(452));
        return l;
      case "head":
        if (l = t.head, !l) throw Error(r(453));
        return l;
      case "body":
        if (l = t.body, !l) throw Error(r(454));
        return l;
      default:
        throw Error(r(451));
    }
  }
  function Au(l) {
    for (var t = l.attributes; t.length; )
      l.removeAttributeNode(t[0]);
    di(l);
  }
  var Tt = /* @__PURE__ */ new Map(), or = /* @__PURE__ */ new Set();
  function Yn(l) {
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
    var l = Pt.f(), t = _n();
    return l || t;
  }
  function Wh(l) {
    var t = Ie(l);
    t !== null && t.tag === 5 && t.type === "form" ? No(t) : Pt.r(l);
  }
  var Ma = typeof document > "u" ? null : document;
  function dr(l, t, e) {
    var a = Ma;
    if (a && typeof t == "string" && t) {
      var u = yt(t);
      u = 'link[rel="' + l + '"][href="' + u + '"]', typeof e == "string" && (u += '[crossorigin="' + e + '"]'), or.has(u) || (or.add(u), l = { rel: l, crossOrigin: e, href: t }, a.querySelector(u) === null && (t = a.createElement("link"), Ql(t, "link", l), Hl(t), a.head.appendChild(t)));
    }
  }
  function kh(l) {
    Pt.D(l), dr("dns-prefetch", l, null);
  }
  function Fh(l, t) {
    Pt.C(l, t), dr("preconnect", l, t);
  }
  function Ih(l, t, e) {
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
      Tt.has(n) || (l = b(
        {
          rel: "preload",
          href: t === "image" && e && e.imageSrcSet ? void 0 : l,
          as: t
        },
        e
      ), Tt.set(n, l), a.querySelector(u) !== null || t === "style" && a.querySelector(ju(n)) || t === "script" && a.querySelector(zu(n)) || (t = a.createElement("link"), Ql(t, "link", l), Hl(t), a.head.appendChild(t)));
    }
  }
  function Ph(l, t) {
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
      if (!Tt.has(n) && (l = b({ rel: "modulepreload", href: l }, t), Tt.set(n, l), e.querySelector(u) === null)) {
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
          ju(n)
        ))
          f.loading = 5;
        else {
          l = b(
            { rel: "stylesheet", href: l, "data-precedence": t },
            e
          ), (e = Tt.get(n)) && df(l, e);
          var o = i = a.createElement("link");
          Hl(o), Ql(o, "link", l), o._p = new Promise(function(y, A) {
            o.onload = y, o.onerror = A;
          }), o.addEventListener("load", function() {
            f.loading |= 1;
          }), o.addEventListener("error", function() {
            f.loading |= 2;
          }), f.loading |= 4, Gn(i, t, a);
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
      n || (n = e.querySelector(zu(u)), n || (l = b({ src: l, async: !0 }, t), (t = Tt.get(u)) && rf(l, t), n = e.createElement("script"), Hl(n), Ql(n, "link", l), e.head.appendChild(n)), n = {
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
      n || (n = e.querySelector(zu(u)), n || (l = b({ src: l, async: !0, type: "module" }, t), (t = Tt.get(u)) && rf(l, t), n = e.createElement("script"), Hl(n), Ql(n, "link", l), e.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, a.set(u, n));
    }
  }
  function rr(l, t, e, a) {
    var u = (u = k.current) ? Yn(u) : null;
    if (!u) throw Error(r(446));
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
            ju(l)
          )) && !n._p && (i.instance = n, i.state.loading = 5), Tt.has(l) || (e = {
            rel: "preload",
            as: "style",
            href: e.href,
            crossOrigin: e.crossOrigin,
            integrity: e.integrity,
            media: e.media,
            hrefLang: e.hrefLang,
            referrerPolicy: e.referrerPolicy
          }, Tt.set(l, e), n || av(
            u,
            l,
            e,
            i.state
          ))), t && a === null)
            throw Error(r(528, ""));
          return i;
        }
        if (t && a !== null)
          throw Error(r(529, ""));
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
        throw Error(r(444, l));
    }
  }
  function Da(l) {
    return 'href="' + yt(l) + '"';
  }
  function ju(l) {
    return 'link[rel="stylesheet"][' + l + "]";
  }
  function mr(l) {
    return b({}, l, {
      "data-precedence": l.precedence,
      precedence: null
    });
  }
  function av(l, t, e, a) {
    l.querySelector('link[rel="preload"][as="style"][' + t + "]") ? a.loading = 1 : (t = l.createElement("link"), a.preload = t, t.addEventListener("load", function() {
      return a.loading |= 1;
    }), t.addEventListener("error", function() {
      return a.loading |= 2;
    }), Ql(t, "link", e), Hl(t), l.head.appendChild(t));
  }
  function Ua(l) {
    return '[src="' + yt(l) + '"]';
  }
  function zu(l) {
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
          var u = b({}, e, {
            "data-href": e.href,
            "data-precedence": e.precedence,
            href: null,
            precedence: null
          });
          return a = (l.ownerDocument || l).createElement(
            "style"
          ), Hl(a), Ql(a, "style", u), Gn(a, e.precedence, l), t.instance = a;
        case "stylesheet":
          u = Da(e.href);
          var n = l.querySelector(
            ju(u)
          );
          if (n)
            return t.state.loading |= 4, t.instance = n, Hl(n), n;
          a = mr(e), (u = Tt.get(u)) && df(a, u), n = (l.ownerDocument || l).createElement("link"), Hl(n);
          var i = n;
          return i._p = new Promise(function(f, o) {
            i.onload = f, i.onerror = o;
          }), Ql(n, "link", a), t.state.loading |= 4, Gn(n, e.precedence, l), t.instance = n;
        case "script":
          return n = Ua(e.src), (u = l.querySelector(
            zu(n)
          )) ? (t.instance = u, Hl(u), u) : (a = e, (u = Tt.get(n)) && (a = b({}, e), rf(a, u)), l = l.ownerDocument || l, u = l.createElement("script"), Hl(u), Ql(u, "link", a), l.head.appendChild(u), t.instance = u);
        case "void":
          return null;
        default:
          throw Error(r(443, t.type));
      }
    else
      t.type === "stylesheet" && (t.state.loading & 4) === 0 && (a = t.instance, t.state.loading |= 4, Gn(a, e.precedence, l));
    return t.instance;
  }
  function Gn(l, t, e) {
    for (var a = e.querySelectorAll(
      'link[rel="stylesheet"][data-precedence],style[data-precedence]'
    ), u = a.length ? a[a.length - 1] : null, n = u, i = 0; i < a.length; i++) {
      var f = a[i];
      if (f.dataset.precedence === t) n = f;
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
        var f = a.get(i);
        f ? f.push(n) : a.set(i, [n]);
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
  function gr(l) {
    return !(l.type === "stylesheet" && (l.state.loading & 3) === 0);
  }
  function nv(l, t, e, a) {
    if (e.type === "stylesheet" && (typeof a.media != "string" || matchMedia(a.media).matches !== !1) && (e.state.loading & 4) === 0) {
      if (e.instance === null) {
        var u = Da(a.href), n = t.querySelector(
          ju(u)
        );
        if (n) {
          t = n._p, t !== null && typeof t == "object" && typeof t.then == "function" && (l.count++, l = Qn.bind(l), t.then(l, l)), e.state.loading |= 4, e.instance = n, Hl(n);
          return;
        }
        n = t.ownerDocument || t, a = mr(a), (u = Tt.get(u)) && df(a, u), n = n.createElement("link"), Hl(n);
        var i = n;
        i._p = new Promise(function(f, o) {
          i.onload = f, i.onerror = o;
        }), Ql(n, "link", a), e.instance = n;
      }
      l.stylesheets === null && (l.stylesheets = /* @__PURE__ */ new Map()), l.stylesheets.set(e, t), (t = e.state.preload) && (e.state.loading & 3) === 0 && (l.count++, e = Qn.bind(l), t.addEventListener("load", e), t.addEventListener("error", e));
    }
  }
  var mf = 0;
  function iv(l, t) {
    return l.stylesheets && l.count === 0 && Zn(l, l.stylesheets), 0 < l.count || 0 < l.imgCount ? function(e) {
      var a = setTimeout(function() {
        if (l.stylesheets && Zn(l, l.stylesheets), l.unsuspend) {
          var n = l.unsuspend;
          l.unsuspend = null, n();
        }
      }, 6e4 + t);
      0 < l.imgBytes && mf === 0 && (mf = 62500 * Lh());
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
  function Qn() {
    if (this.count--, this.count === 0 && (this.imgCount === 0 || !this.waitingForImages)) {
      if (this.stylesheets) Zn(this, this.stylesheets);
      else if (this.unsuspend) {
        var l = this.unsuspend;
        this.unsuspend = null, l();
      }
    }
  }
  var Xn = null;
  function Zn(l, t) {
    l.stylesheets = null, l.unsuspend !== null && (l.count++, Xn = /* @__PURE__ */ new Map(), t.forEach(cv, l), Xn = null, Qn.call(l));
  }
  function cv(l, t) {
    if (!(t.state.loading & 4)) {
      var e = Xn.get(l);
      if (e) var a = e.get(null);
      else {
        e = /* @__PURE__ */ new Map(), Xn.set(l, e);
        for (var u = l.querySelectorAll(
          "link[data-precedence],style[data-precedence]"
        ), n = 0; n < u.length; n++) {
          var i = u[n];
          (i.nodeName === "LINK" || i.getAttribute("media") !== "not all") && (e.set(i.dataset.precedence, i), a = i);
        }
        a && e.set(null, a);
      }
      u = t.instance, i = u.getAttribute("data-precedence"), n = e.get(i) || a, n === a && e.set(null, u), e.set(i, u), this.count++, a = Qn.bind(this), u.addEventListener("load", a), u.addEventListener("error", a), n ? n.parentNode.insertBefore(u, n.nextSibling) : (l = l.nodeType === 9 ? l.head : l, l.insertBefore(u, l.firstChild)), t.state.loading |= 4;
    }
  }
  var Tu = {
    $$typeof: Rl,
    Provider: null,
    Consumer: null,
    _currentValue: V,
    _currentValue2: V,
    _threadCount: 0
  };
  function fv(l, t, e, a, u, n, i, f, o) {
    this.tag = 1, this.containerInfo = l, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = ci(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = ci(0), this.hiddenUpdates = ci(null), this.identifierPrefix = a, this.onUncaughtError = u, this.onCaughtError = n, this.onRecoverableError = i, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = o, this.incompleteTransitions = /* @__PURE__ */ new Map();
  }
  function br(l, t, e, a, u, n, i, f, o, y, A, x) {
    return l = new fv(
      l,
      t,
      e,
      i,
      o,
      y,
      A,
      x,
      f
    ), t = 1, n === !0 && (t |= 24), n = ft(3, null, null, t), l.current = n, n.stateNode = l, t = Ki(), t.refCount++, l.pooledCache = t, t.refCount++, n.memoizedState = {
      element: a,
      isDehydrated: e,
      cache: t
    }, Wi(n), l;
  }
  function Sr(l) {
    return l ? (l = sa, l) : sa;
  }
  function pr(l, t, e, a, u, n) {
    u = Sr(u), a.context === null ? a.context = u : a.pendingContext = u, a = se(t), a.payload = { element: e }, n = n === void 0 ? null : n, n !== null && (a.callback = n), e = oe(l, a, t), e !== null && (tt(e, l, t), eu(e, l, t));
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
  function jr(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = Ce(l, 67108864);
      t !== null && tt(t, l, 67108864), hf(l, 67108864);
    }
  }
  function zr(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = mt();
      t = fi(t);
      var e = Ce(l, t);
      e !== null && tt(e, l, t), hf(l, t);
    }
  }
  var Vn = !0;
  function sv(l, t, e, a) {
    var u = z.T;
    z.T = null;
    var n = U.p;
    try {
      U.p = 2, vf(l, t, e, a);
    } finally {
      U.p = n, z.T = u;
    }
  }
  function ov(l, t, e, a) {
    var u = z.T;
    z.T = null;
    var n = U.p;
    try {
      U.p = 8, vf(l, t, e, a);
    } finally {
      U.p = n, z.T = u;
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
        ), xr(l, a);
      else if (rv(
        u,
        l,
        t,
        e,
        a
      ))
        a.stopPropagation();
      else if (xr(l, a), t & 4 && -1 < dv.indexOf(l)) {
        for (; u !== null; ) {
          var n = Ie(u);
          if (n !== null)
            switch (n.tag) {
              case 3:
                if (n = n.stateNode, n.current.memoizedState.isDehydrated) {
                  var i = _e(n.pendingLanes);
                  if (i !== 0) {
                    var f = n;
                    for (f.pendingLanes |= 2, f.entangledLanes |= 2; i; ) {
                      var o = 1 << 31 - it(i);
                      f.entanglements[1] |= o, i &= ~o;
                    }
                    Ct(n), (nl & 6) === 0 && (Nn = ut() + 500, bu(0));
                  }
                }
                break;
              case 31:
              case 13:
                f = Ce(n, 2), f !== null && tt(f, n, 2), _n(), hf(n, 2);
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
      var t = D(l);
      if (t === null) l = null;
      else {
        var e = t.tag;
        if (e === 13) {
          if (l = L(t), l !== null) return l;
          l = null;
        } else if (e === 31) {
          if (l = Z(t), l !== null) return l;
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
          case Df:
            return 2;
          case Uf:
            return 8;
          case Ru:
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
  var bf = !1, Ae = null, je = null, ze = null, xu = /* @__PURE__ */ new Map(), Eu = /* @__PURE__ */ new Map(), Te = [], dv = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
    " "
  );
  function xr(l, t) {
    switch (l) {
      case "focusin":
      case "focusout":
        Ae = null;
        break;
      case "dragenter":
      case "dragleave":
        je = null;
        break;
      case "mouseover":
      case "mouseout":
        ze = null;
        break;
      case "pointerover":
      case "pointerout":
        xu.delete(t.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        Eu.delete(t.pointerId);
    }
  }
  function Nu(l, t, e, a, u, n) {
    return l === null || l.nativeEvent !== n ? (l = {
      blockedOn: t,
      domEventName: e,
      eventSystemFlags: a,
      nativeEvent: n,
      targetContainers: [u]
    }, t !== null && (t = Ie(t), t !== null && jr(t)), l) : (l.eventSystemFlags |= a, t = l.targetContainers, u !== null && t.indexOf(u) === -1 && t.push(u), l);
  }
  function rv(l, t, e, a, u) {
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
        return je = Nu(
          je,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "mouseover":
        return ze = Nu(
          ze,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "pointerover":
        var n = u.pointerId;
        return xu.set(
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
      case "gotpointercapture":
        return n = u.pointerId, Eu.set(
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
    }
    return !1;
  }
  function Er(l) {
    var t = Fe(l.target);
    if (t !== null) {
      var e = D(t);
      if (e !== null) {
        if (t = e.tag, t === 13) {
          if (t = L(e), t !== null) {
            l.blockedOn = t, Gf(l.priority, function() {
              zr(e);
            });
            return;
          }
        } else if (t === 31) {
          if (t = Z(e), t !== null) {
            l.blockedOn = t, Gf(l.priority, function() {
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
        return t = Ie(e), t !== null && jr(t), l.blockedOn = e, !1;
      t.shift();
    }
    return !0;
  }
  function Nr(l, t, e) {
    Jn(l) && e.delete(t);
  }
  function mv() {
    bf = !1, Ae !== null && Jn(Ae) && (Ae = null), je !== null && Jn(je) && (je = null), ze !== null && Jn(ze) && (ze = null), xu.forEach(Nr), Eu.forEach(Nr);
  }
  function wn(l, t) {
    l.blockedOn === t && (l.blockedOn = null, bf || (bf = !0, s.unstable_scheduleCallback(
      s.unstable_NormalPriority,
      mv
    )));
  }
  var $n = null;
  function Or(l) {
    $n !== l && ($n = l, s.unstable_scheduleCallback(
      s.unstable_NormalPriority,
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
    function t(o) {
      return wn(o, l);
    }
    Ae !== null && wn(Ae, l), je !== null && wn(je, l), ze !== null && wn(ze, l), xu.forEach(t), Eu.forEach(t);
    for (var e = 0; e < Te.length; e++) {
      var a = Te[e];
      a.blockedOn === l && (a.blockedOn = null);
    }
    for (; 0 < Te.length && (e = Te[0], e.blockedOn === null); )
      Er(e), e.blockedOn === null && Te.shift();
    if (e = (l.ownerDocument || l).$$reactFormReplay, e != null)
      for (a = 0; a < e.length; a += 3) {
        var u = e[a], n = e[a + 1], i = u[Wl] || null;
        if (typeof n == "function")
          i || Or(e);
        else if (i) {
          var f = null;
          if (n && n.hasAttribute("formAction")) {
            if (u = n, i = n[Wl] || null)
              f = i.formAction;
            else if (gf(u) !== null) continue;
          } else f = i.action;
          typeof f == "function" ? e[a + 1] = f : (e.splice(a, 3), a -= 3), Or(e);
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
  function Sf(l) {
    this._internalRoot = l;
  }
  Wn.prototype.render = Sf.prototype.render = function(l) {
    var t = this._internalRoot;
    if (t === null) throw Error(r(409));
    var e = t.current, a = mt();
    pr(e, a, l, t, null, null);
  }, Wn.prototype.unmount = Sf.prototype.unmount = function() {
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
      for (var e = 0; e < Te.length && t !== 0 && t < Te[e].priority; e++) ;
      Te.splice(e, 0, l), e === 0 && Er(l);
    }
  };
  var Mr = j.version;
  if (Mr !== "19.2.8")
    throw Error(
      r(
        527,
        Mr,
        "19.2.8"
      )
    );
  U.findDOMNode = function(l) {
    var t = l._reactInternals;
    if (t === void 0)
      throw typeof l.render == "function" ? Error(r(188)) : (l = Object.keys(l).join(","), Error(r(268, l)));
    return l = p(t), l = l !== null ? M(l) : null, l = l === null ? null : l.stateNode, l;
  };
  var hv = {
    bundleType: 0,
    version: "19.2.8",
    rendererPackageName: "react-dom",
    currentDispatcherRef: z,
    reconcilerVersion: "19.2.8"
  };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var kn = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!kn.isDisabled && kn.supportsFiber)
      try {
        qa = kn.inject(
          hv
        ), nt = kn;
      } catch {
      }
  }
  return _u.createRoot = function(l, t) {
    if (!H(l)) throw Error(r(299));
    var e = !1, a = "", u = Bo, n = Yo, i = Go;
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
      _r
    ), l[ke] = t.current, Pc(l), new Sf(t);
  }, _u.hydrateRoot = function(l, t, e) {
    if (!H(l)) throw Error(r(299));
    var a = !1, u = "", n = Bo, i = Yo, f = Go, o = null;
    return e != null && (e.unstable_strictMode === !0 && (a = !0), e.identifierPrefix !== void 0 && (u = e.identifierPrefix), e.onUncaughtError !== void 0 && (n = e.onUncaughtError), e.onCaughtError !== void 0 && (i = e.onCaughtError), e.onRecoverableError !== void 0 && (f = e.onRecoverableError), e.formState !== void 0 && (o = e.formState)), t = br(
      l,
      1,
      !0,
      t,
      e ?? null,
      a,
      u,
      o,
      n,
      i,
      f,
      _r
    ), t.context = Sr(null), e = t.current, a = mt(), a = fi(a), u = se(a), u.callback = null, oe(e, u, a), e = a, t.current.lanes = e, Ya(t, e), Ct(t), l[ke] = t.current, Pc(l), new Wn(t);
  }, _u.version = "19.2.8", _u;
}
var Lr;
function Tv() {
  if (Lr) return jf.exports;
  Lr = 1;
  function s() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(s);
      } catch (j) {
        console.error(j);
      }
  }
  return s(), jf.exports = zv(), jf.exports;
}
var xv = Tv();
class Ev extends Error {
  constructor(j, _, r) {
    super(j), this.status = _, this.payload = r;
  }
  status;
  payload;
}
const Nv = 15e3;
async function et(s, j = {}) {
  const _ = new Headers(j.headers);
  j.body && !_.has("content-type") && _.set("content-type", "application/json");
  const r = new AbortController();
  let H = !1;
  const D = j.signal, L = () => r.abort();
  D && (D.aborted ? L() : D.addEventListener("abort", L, { once: !0 }));
  const Z = setTimeout(() => {
    H = !0, r.abort();
  }, Nv);
  try {
    const N = await fetch(s, { ...j, headers: _, signal: r.signal, credentials: "same-origin" });
    let p = {};
    try {
      p = await N.json();
    } catch {
    }
    if (!N.ok) {
      const M = p && typeof p == "object" ? p : {}, b = typeof M.error == "string" ? M.error : typeof M.message == "string" ? M.message : `Request failed (${N.status})`;
      throw new Ev(b, N.status, p);
    }
    return p;
  } catch (N) {
    throw H ? new Error("Forge Runtime 暂时没有响应。请在连接恢复后重试。") : N;
  } finally {
    clearTimeout(Z), D?.removeEventListener("abort", L);
  }
}
const at = {
  commandCenter: () => et("/api/console/command-center"),
  work: () => et("/api/console/requirements"),
  workPortfolio: () => et("/api/console/work-portfolio"),
  automations: () => et("/api/console/automations"),
  automationSettings: () => et("/api/console/automation-settings"),
  connector: () => et("/api/console/connector/status"),
  advanced: () => et("/api/console/advanced"),
  automationAction: (s, j, _, r) => et(`/api/console/automations/${encodeURIComponent(s)}/${encodeURIComponent(j)}/${encodeURIComponent(_)}/${encodeURIComponent(r)}`, { method: "POST", body: "{}" }),
  providerAction: (s, j) => et(`/api/console/providers/${encodeURIComponent(s)}/${j}`, { method: "POST", body: "{}" }),
  providerHealth: (s) => et("/api/console/providers/health", { method: "POST", body: JSON.stringify({ providerId: s }) }),
  localToolAction: (s, j) => et(`/api/console/local-tools/${encodeURIComponent(s)}/${j}`, { method: "POST", body: "{}" }),
  localToolHealth: (s) => et("/api/console/local-tools/health", { method: "POST", body: JSON.stringify({ toolId: s }) }),
  registerRepository: (s, j) => et("/api/repositories/register", { method: "POST", body: JSON.stringify({ path: s, displayName: j }) }),
  removeRepository: (s) => et(`/api/repositories/${encodeURIComponent(s)}/remove`, { method: "POST", body: "{}" })
}, Kr = [
  { id: "overview", label: "Overview", group: "daily" },
  { id: "automations", label: "Automations", group: "daily" },
  { id: "work", label: "Work", group: "daily" },
  { id: "capabilities", label: "Capabilities", group: "manage" },
  { id: "repositories", label: "Repositories", group: "manage" },
  { id: "settings", label: "Settings", group: "manage" },
  { id: "system", label: "System", group: "system" }
];
function Qr() {
  const s = location.hash.replace(/^#\/?/, "").split("/")[0];
  return Kr.some((j) => j.id === s) ? s : "overview";
}
function le({ children: s, ...j }) {
  return /* @__PURE__ */ c.jsx("svg", { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: "1.55", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", ...j, children: s });
}
const Ov = (s) => /* @__PURE__ */ c.jsx(le, { ...s, children: /* @__PURE__ */ c.jsx("path", { d: "M3 9.2 10 3l7 6.2v7.1a.7.7 0 0 1-.7.7h-4.2v-5H7.9v5H3.7a.7.7 0 0 1-.7-.7z" }) }), _v = (s) => /* @__PURE__ */ c.jsxs(le, { ...s, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4.2 6.3A6.5 6.5 0 0 1 16 7" }),
  /* @__PURE__ */ c.jsx("path", { d: "m16 3 .4 4.4-4.4.4" }),
  /* @__PURE__ */ c.jsx("path", { d: "M15.8 13.7A6.5 6.5 0 0 1 4 13" }),
  /* @__PURE__ */ c.jsx("path", { d: "m4 17-.4-4.4 4.4-.4" })
] }), Mv = (s) => /* @__PURE__ */ c.jsxs(le, { ...s, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4 5.2h12v10.6H4z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M7 5.2V3.6h6v1.6M7 9h6M7 12h4" })
] }), Dv = (s) => /* @__PURE__ */ c.jsx(le, { ...s, children: /* @__PURE__ */ c.jsx("path", { d: "m10 2.8 2 4 4.4.7-3.2 3.1.8 4.4-4-2.1L6 15l.8-4.4-3.2-3.1L8 6.8z" }) }), Uv = (s) => /* @__PURE__ */ c.jsxs(le, { ...s, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4 3.5h5l1.4 2H16v11H4z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M4 8h12" })
] }), Rv = (s) => /* @__PURE__ */ c.jsxs(le, { ...s, children: [
  /* @__PURE__ */ c.jsx("circle", { cx: "10", cy: "10", r: "2.5" }),
  /* @__PURE__ */ c.jsx("path", { d: "M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" })
] }), Cv = (s) => /* @__PURE__ */ c.jsxs(le, { ...s, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M3.2 4.5h13.6v9.2H3.2z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M7 17h6M10 13.7V17" })
] }), Hv = (s) => /* @__PURE__ */ c.jsxs(le, { ...s, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M15.5 6A6 6 0 1 0 16 12" }),
  /* @__PURE__ */ c.jsx("path", { d: "m15.5 2.8.3 3.7-3.7.2" })
] }), qv = (s) => /* @__PURE__ */ c.jsxs(le, { ...s, children: [
  /* @__PURE__ */ c.jsx("circle", { cx: "8.8", cy: "8.8", r: "5" }),
  /* @__PURE__ */ c.jsx("path", { d: "m12.5 12.5 4 4" })
] }), Bv = { overview: Ov, automations: _v, work: Mv, capabilities: Dv, repositories: Uv, settings: Rv, system: Cv }, Yv = { daily: "Workspace", manage: "Configure", system: "System" };
function Gv({ route: s }) {
  let j = "";
  return /* @__PURE__ */ c.jsxs("aside", { className: "sidebar", children: [
    /* @__PURE__ */ c.jsxs("div", { className: "brand", children: [
      /* @__PURE__ */ c.jsx("span", { className: "brand-mark", children: "F" }),
      /* @__PURE__ */ c.jsxs("div", { children: [
        /* @__PURE__ */ c.jsx("strong", { children: "Forge" }),
        /* @__PURE__ */ c.jsx("small", { children: "Utility Console" })
      ] })
    ] }),
    /* @__PURE__ */ c.jsx("nav", { children: Kr.map((_) => {
      const r = Bv[_.id], H = _.group !== j;
      return j = _.group, /* @__PURE__ */ c.jsxs("div", { className: H ? "nav-group-start" : "nav-item", children: [
        H && /* @__PURE__ */ c.jsx("div", { className: "nav-group-label", children: Yv[_.group] }),
        /* @__PURE__ */ c.jsxs("a", { href: `#/${_.id}`, className: s === _.id ? "active" : "", children: [
          /* @__PURE__ */ c.jsx(r, {}),
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
function Lv({ route: s, children: j }) {
  return /* @__PURE__ */ c.jsxs("div", { className: "app-shell", children: [
    /* @__PURE__ */ c.jsx(Gv, { route: s }),
    /* @__PURE__ */ c.jsx("main", { className: "workspace", children: j })
  ] });
}
function we(s) {
  if (!s) return "—";
  const j = new Date(s);
  return Number.isNaN(j.getTime()) ? s : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: !1 }).format(j);
}
function xt(s, j = 86) {
  const _ = (s ?? "").trim();
  return _.length > j ? `${_.slice(0, j - 1)}…` : _;
}
function Ca(s, j = "—") {
  return typeof s == "string" && s.trim() ? s : String(s ?? j);
}
function Pn(s) {
  return JSON.stringify(s ?? {}, null, 2);
}
function $e({ eyebrow: s, title: j, description: _, refreshedAt: r, busy: H, onRefresh: D, actions: L }) {
  return /* @__PURE__ */ c.jsxs("header", { className: "command-bar", children: [
    /* @__PURE__ */ c.jsxs("div", { className: "command-title", children: [
      s && /* @__PURE__ */ c.jsx("div", { className: "eyebrow", children: s }),
      /* @__PURE__ */ c.jsx("h1", { children: j }),
      /* @__PURE__ */ c.jsx("p", { children: _ })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "command-actions", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "command-meta", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Last synced" }),
        /* @__PURE__ */ c.jsx("strong", { children: we(r) })
      ] }),
      /* @__PURE__ */ c.jsx("button", { className: "icon-button", onClick: D, disabled: H, title: "Refresh", children: /* @__PURE__ */ c.jsx(Hv, {}) }),
      L,
      /* @__PURE__ */ c.jsx("a", { className: "button ghost-link", href: "https://chatgpt.com", target: "_blank", rel: "noreferrer", children: "Open ChatGPT ↗" })
    ] })
  ] });
}
function Qv(s) {
  const j = (s ?? "").toLowerCase();
  return /ready|enabled|healthy|success|done|completed|active/.test(j) ? "success" : /attention|blocked|error|fail|danger/.test(j) ? "danger" : /pause|waiting|warn|degrad|stale|planned/.test(j) ? "warning" : /info|running/.test(j) ? "info" : "neutral";
}
function Zl({ label: s, tone: j }) {
  const _ = j && ["success", "warning", "danger", "info", "neutral"].includes(j) ? j : Qv(j ?? s);
  return /* @__PURE__ */ c.jsxs("span", { className: "status-text", children: [
    /* @__PURE__ */ c.jsx("i", { className: `status-dot ${_}` }),
    s
  ] });
}
function In({ title: s, meta: j, actions: _ }) {
  return /* @__PURE__ */ c.jsxs("div", { className: "section-header", children: [
    /* @__PURE__ */ c.jsxs("div", { children: [
      /* @__PURE__ */ c.jsx("h2", { children: s }),
      j && /* @__PURE__ */ c.jsx("span", { children: j })
    ] }),
    _ && /* @__PURE__ */ c.jsx("div", { children: _ })
  ] });
}
function Xv(s) {
  return s.advanced?.status ?? "";
}
function Zv(s) {
  return ["blocked", "failed"].includes(Xv(s));
}
function Ef(s) {
  return `${String(s.title ?? "")}:${String(s.reason ?? "")}`;
}
function Vv(s) {
  const j = `${s.readinessLabel ?? ""} ${s.statusLabel ?? ""}`;
  return /error|failed|blocked|unavailable|degraded|warning|attention/i.test(j);
}
function Kv({ data: s, busy: j, onRefresh: _ }) {
  const r = s.commandCenter, H = s.workPortfolio, D = s.automations.summary, L = r.pluginSummary ?? {}, Z = r.repositories ?? [], N = r.readiness ?? {}, p = L.total ?? (r.plugins ?? []).length, M = Z.filter(Vv).length, b = String(N.state ?? N.status ?? "ready"), C = /error|failed|blocked|unavailable|degraded|warning|attention/i.test(b), O = String(N.label ?? N.headline ?? (C ? "Needs attention" : "Ready")), xl = H.items.filter(Zv).slice(0, 4), El = [...r.handoffs ?? []].filter((X, $, Cl) => Cl.findIndex((wl) => Ef(wl) === Ef(X)) === $), Nl = [
    ...C ? [{
      key: "runtime",
      source: "System",
      title: O,
      summary: xt(String(N.explanation ?? N.summary ?? "Inspect Runtime status."), 112),
      statusLabel: "Inspect",
      tone: b,
      href: "#/system"
    }] : [],
    ...xl.map((X) => ({
      key: `work:${X.id}`,
      source: `Work · ${X.repositoryName}`,
      title: X.title,
      summary: xt(X.latestSummary || X.nextAction || X.objective, 112),
      statusLabel: X.statusLabel,
      tone: X.tone ?? "warning",
      href: "#/work"
    })),
    ...El.slice(0, 2).map((X, $) => ({
      key: `handoff:${$}:${Ef(X)}`,
      source: "Decision",
      title: String(X.title ?? "Needs review"),
      summary: xt(String(X.reason ?? X.summary ?? "Review in ChatGPT."), 112),
      statusLabel: String(X.statusLabel ?? "Review"),
      tone: String(X.tone ?? "warning"),
      href: "#/work"
    })),
    ...(D.needsAttention ?? 0) > 0 ? [{
      key: "automations",
      source: "Automations",
      title: `${D.needsAttention} automation${D.needsAttention === 1 ? "" : "s"} need attention`,
      summary: "Inspect configured routines and schedules.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/automations"
    }] : [],
    ...(L.needsAttention ?? 0) > 0 ? [{
      key: "capabilities",
      source: "Capabilities",
      title: `${L.needsAttention} ${L.needsAttention === 1 ? "capability" : "capabilities"} need attention`,
      summary: "Inspect configured capability readiness.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/capabilities"
    }] : [],
    ...M > 0 ? [{
      key: "repositories",
      source: "Repositories",
      title: `${M} ${M === 1 ? "repository" : "repositories"} need attention`,
      summary: "Inspect repository registration and readiness.",
      statusLabel: "Inspect",
      tone: "warning",
      href: "#/repositories"
    }] : []
  ].filter((X, $, Cl) => Cl.findIndex((wl) => wl.key === X.key) === $).slice(0, 6), cl = H.summary.needsAttention ? `${H.summary.open} open · ${H.summary.needsAttention} need attention` : `${H.summary.open} open · no attention needed`, tl = D.needsAttention ? `${D.enabled} 个运行中 · ${D.needsAttention} 个需要处理` : D.paused ? `${D.enabled} 个运行中 · ${D.paused} 个已暂停` : (D.completed ?? 0) > 0 ? `${D.enabled} 个运行中 · ${D.completed} 个已完成` : `${D.enabled} 个运行中 · 状态正常`, Rl = (L.needsAttention ?? 0) > 0 ? `${L.ready ?? 0} / ${p} ready · ${L.needsAttention} need attention` : `${L.ready ?? 0} / ${p} ready`, Jl = M ? `${Z.length} registered · ${M} need attention` : `${Z.length} registered`, ht = [
    { key: "work", label: "Work", summary: cl, href: "#/work", statusLabel: H.summary.needsAttention ? "Attention" : void 0, tone: H.summary.needsAttention ? "warning" : void 0 },
    { key: "automations", label: "Automations", summary: tl, href: "#/automations", statusLabel: D.needsAttention ? "Attention" : void 0, tone: D.needsAttention ? "warning" : void 0 },
    { key: "capabilities", label: "Capabilities", summary: Rl, href: "#/capabilities", statusLabel: (L.needsAttention ?? 0) > 0 ? "Attention" : void 0, tone: (L.needsAttention ?? 0) > 0 ? "warning" : void 0 },
    { key: "repositories", label: "Repositories", summary: Jl, href: "#/repositories", statusLabel: M ? "Attention" : void 0, tone: M ? "warning" : void 0 },
    { key: "system", label: "System", summary: C ? O : "Runtime ready", href: "#/system", statusLabel: C ? "Attention" : "Ready", tone: C ? b : "success" }
  ];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx(
      $e,
      {
        eyebrow: "FORGE CONTROL PLANE",
        title: "Overview",
        description: "需要处理的事项，以及 Forge 各工作区当前状态。",
        refreshedAt: s.generatedAt,
        busy: j,
        onRefresh: _
      }
    ),
    /* @__PURE__ */ c.jsxs("div", { className: "overview-home", children: [
      /* @__PURE__ */ c.jsxs("section", { className: "page-section overview-attention-section", children: [
        /* @__PURE__ */ c.jsx(In, { title: "Needs attention", meta: Nl.length ? `${Nl.length} items` : "All clear" }),
        Nl.length ? /* @__PURE__ */ c.jsx("div", { className: "overview-attention-list", children: Nl.map((X) => /* @__PURE__ */ c.jsxs("a", { className: "overview-attention-row", href: X.href, children: [
          /* @__PURE__ */ c.jsx("div", { className: "overview-attention-source", children: X.source }),
          /* @__PURE__ */ c.jsxs("div", { className: "overview-attention-copy", children: [
            /* @__PURE__ */ c.jsx("strong", { children: xt(X.title, 82) }),
            /* @__PURE__ */ c.jsx("p", { children: X.summary })
          ] }),
          /* @__PURE__ */ c.jsx(Zl, { label: X.statusLabel, tone: X.tone }),
          /* @__PURE__ */ c.jsx("span", { className: "overview-row-arrow", "aria-hidden": "true", children: "→" })
        ] }, X.key)) }) : /* @__PURE__ */ c.jsxs("div", { className: "overview-clear-state", children: [
          /* @__PURE__ */ c.jsx(Zl, { label: "No action needed", tone: "success" }),
          /* @__PURE__ */ c.jsx("span", { children: "Forge is operating normally." })
        ] })
      ] }),
      /* @__PURE__ */ c.jsxs("section", { className: "page-section overview-workspace-section", children: [
        /* @__PURE__ */ c.jsx(In, { title: "Workspace", meta: "Current state" }),
        /* @__PURE__ */ c.jsx("div", { className: "overview-workspace-list", children: ht.map((X) => /* @__PURE__ */ c.jsxs("a", { className: "overview-workspace-row", href: X.href, children: [
          /* @__PURE__ */ c.jsx("strong", { children: X.label }),
          /* @__PURE__ */ c.jsx("span", { children: X.summary }),
          X.statusLabel && /* @__PURE__ */ c.jsx(Zl, { label: X.statusLabel, tone: X.tone }),
          /* @__PURE__ */ c.jsx("span", { className: "overview-row-arrow", "aria-hidden": "true", children: "→" })
        ] }, X.key)) })
      ] })
    ] })
  ] });
}
function Of({ items: s, value: j, onChange: _ }) {
  return /* @__PURE__ */ c.jsx("div", { className: "segmented", role: "tablist", children: s.map((r) => /* @__PURE__ */ c.jsxs("button", { role: "tab", "aria-selected": j === r.id, className: j === r.id ? "selected" : "", onClick: () => _(r.id), children: [
    r.label,
    r.count !== void 0 && /* @__PURE__ */ c.jsx("span", { children: r.count })
  ] }, r.id)) });
}
function li({ title: s, subtitle: j, actions: _, children: r, empty: H }) {
  return /* @__PURE__ */ c.jsx("aside", { className: "detail-pane", children: s ? /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsxs("div", { className: "detail-head", children: [
      /* @__PURE__ */ c.jsxs("div", { children: [
        /* @__PURE__ */ c.jsx("div", { className: "eyebrow", children: "DETAIL" }),
        /* @__PURE__ */ c.jsx("h2", { children: s }),
        j && /* @__PURE__ */ c.jsx("p", { children: j })
      ] }),
      _ && /* @__PURE__ */ c.jsx("div", { className: "detail-actions", children: _ })
    ] }),
    /* @__PURE__ */ c.jsx("div", { className: "detail-body", children: r })
  ] }) : /* @__PURE__ */ c.jsx("div", { className: "detail-empty", children: H ?? "选择一项查看详细配置" }) });
}
function Du({ items: s }) {
  return /* @__PURE__ */ c.jsx("dl", { className: "definition-list", children: s.map(([j, _]) => /* @__PURE__ */ c.jsxs("div", { children: [
    /* @__PURE__ */ c.jsx("dt", { children: j }),
    /* @__PURE__ */ c.jsx("dd", { children: _ })
  ] }, j)) });
}
function Ee({ children: s, className: j = "", ..._ }) {
  return /* @__PURE__ */ c.jsx("button", { className: `button ${j}`.trim(), ..._, children: s });
}
function Xr(s) {
  return s === "enabled" ? "运行中" : s === "paused" ? "已暂停" : s === "attention" ? "需要处理" : s === "completed" ? "已完成" : "已停用";
}
function Zr(s) {
  return s === "enabled" ? "success" : s === "attention" ? "danger" : s === "paused" ? "warning" : s === "completed" ? "success" : "neutral";
}
function Jv(s) {
  if (s === "baseline") return "已建立基线";
  if (s === "unchanged") return "无变化";
  if (s === "changed") return "检测到变化";
  if (s === "keepalive") return "登录保持正常";
  if (s === "auth_required") return "需要重新登录";
}
function wv(s) {
  return s === "high" ? "高" : s === "medium" ? "中" : s === "xhigh" ? "超高" : s ?? "—";
}
function $v(s) {
  return s === "auto" ? "自动 · 同一任务优先复用" : s === "reuse" ? "始终复用已绑定会话" : s === "new" ? "每次新开标签页" : s ?? "—";
}
function Wv(s) {
  return s.agentModel ? [
    ["执行模型", `${s.agentModel} · ${wv(s.reasoningLevel)}推理`],
    ["标签页策略", $v(s.tabPolicy)]
  ] : [];
}
function kv(s, j = !1) {
  return j ? "不会再次触发" : s ? Number.isFinite(Date.parse(s)) ? we(s) : s : "等待下一次计划";
}
function Fv(s) {
  return s === "green" ? "success" : s === "amber" ? "warning" : s === "red" ? "danger" : s === "blue" ? "info" : "neutral";
}
function Iv({ items: s }) {
  return s.length ? /* @__PURE__ */ c.jsx("div", { className: "automation-history", children: s.map((j) => /* @__PURE__ */ c.jsxs("div", { className: "automation-history-row", children: [
    /* @__PURE__ */ c.jsx("div", { className: `automation-history-mark ${j.tone}` }),
    /* @__PURE__ */ c.jsxs("div", { className: "automation-history-copy", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "automation-history-top", children: [
        /* @__PURE__ */ c.jsx(Zl, { label: j.result, tone: Fv(j.tone) }),
        /* @__PURE__ */ c.jsx("time", { children: we(j.at) })
      ] }),
      j.reason && /* @__PURE__ */ c.jsx("p", { children: j.reason }),
      j.trigger && /* @__PURE__ */ c.jsxs("small", { children: [
        j.trigger,
        "触发"
      ] })
    ] })
  ] }, j.id)) }) : /* @__PURE__ */ c.jsx("div", { className: "automation-history-empty", children: "还没有执行记录。" });
}
function Pv({ data: s, busy: j, onRefresh: _, onAction: r }) {
  const H = s.automations.automations, [D, L] = bl.useState("enabled"), Z = bl.useMemo(() => H.filter((O) => D === "all" || (D === "paused" ? O.status === "paused" || O.status === "disabled" : O.status === D)), [H, D]), [N, p] = bl.useState(), M = (O) => `${O.source}:${O.repoId}:${O.id}`, b = Z.find((O) => M(O) === N) ?? Z[0], C = b ? Jv(b.observationStatus) : void 0;
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "AUTOMATION", title: "自动任务", description: "查看哪些任务正在运行、何时再次执行、是否需要处理，以及最近实际发生了什么。", refreshedAt: s.automations.generatedAt, busy: j, onRefresh: _ }),
    /* @__PURE__ */ c.jsx("div", { className: "toolbar automation-toolbar", children: /* @__PURE__ */ c.jsx(Of, { value: D, onChange: L, items: [
      { id: "enabled", label: "运行中", count: H.filter((O) => O.status === "enabled").length },
      { id: "paused", label: "已暂停", count: H.filter((O) => O.status === "paused" || O.status === "disabled").length },
      { id: "attention", label: "需要处理", count: H.filter((O) => O.status === "attention").length },
      { id: "completed", label: "已完成", count: H.filter((O) => O.status === "completed").length },
      { id: "all", label: "全部", count: H.length }
    ] }) }),
    /* @__PURE__ */ c.jsxs("div", { className: "split-workspace automation-layout", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "table-wrap", children: [
        /* @__PURE__ */ c.jsxs("table", { className: "data-table automation-table", children: [
          /* @__PURE__ */ c.jsx("thead", { children: /* @__PURE__ */ c.jsxs("tr", { children: [
            /* @__PURE__ */ c.jsx("th", { children: "自动任务" }),
            /* @__PURE__ */ c.jsx("th", { children: "触发" }),
            /* @__PURE__ */ c.jsx("th", { children: "行为" }),
            /* @__PURE__ */ c.jsx("th", { children: "状态" }),
            /* @__PURE__ */ c.jsx("th", { children: "最近结果" })
          ] }) }),
          /* @__PURE__ */ c.jsx("tbody", { children: Z.map((O) => /* @__PURE__ */ c.jsxs("tr", { className: b && M(b) === M(O) ? "selected" : "", onClick: () => p(M(O)), children: [
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx("strong", { children: O.name }),
              /* @__PURE__ */ c.jsxs("small", { children: [
                O.repositoryName,
                " · ",
                O.modeLabel
              ] })
            ] }),
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx("span", { children: O.schedule }),
              /* @__PURE__ */ c.jsx("small", { children: O.timezone ?? "本地时区" })
            ] }),
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx("span", { children: O.delivery ?? "本地执行" }),
              O.targetLabel && /* @__PURE__ */ c.jsx("small", { children: O.targetLabel })
            ] }),
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx(Zl, { label: Xr(O.status), tone: Zr(O.status) }),
              O.live !== void 0 && /* @__PURE__ */ c.jsx("small", { children: O.live ? "实际执行" : "仅预演" })
            ] }),
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx("span", { children: xt(O.lastResult, 26) || "—" }),
              /* @__PURE__ */ c.jsx("small", { children: we(O.lastRunAt) })
            ] })
          ] }, M(O))) })
        ] }),
        !Z.length && /* @__PURE__ */ c.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Automation。" })
      ] }),
      /* @__PURE__ */ c.jsx(li, { title: b?.name, subtitle: b?.summary, empty: "选择一个 Automation 查看配置与执行历史", children: b && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsxs("div", { className: "automation-detail-status", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("span", { className: "eyebrow", children: "当前状态" }),
            /* @__PURE__ */ c.jsx(Zl, { label: Xr(b.status), tone: Zr(b.status) })
          ] }),
          /* @__PURE__ */ c.jsxs("div", { className: "automation-result", children: [
            /* @__PURE__ */ c.jsx("strong", { children: b.lastResult ?? "尚未执行" }),
            /* @__PURE__ */ c.jsx("small", { children: we(b.observationAt ?? b.lastRunAt) })
          ] })
        ] }),
        /* @__PURE__ */ c.jsx(Du, { items: [
          ["类型", b.modeLabel],
          ["触发计划", `${b.schedule}${b.timezone ? ` · ${b.timezone}` : ""}`],
          ["触发后的行为", b.delivery ?? "本地执行"],
          ["下次执行", kv(b.nextRunHint, b.status === "completed")],
          ["观察目标", b.targetLabel ?? "—"],
          ["观察状态", C ?? "—"],
          ["关联工作", b.boundWorkObjective ? xt(b.boundWorkObjective, 96) : b.boundWorkId ?? "—"],
          ["执行方式", b.live === void 0 ? "—" : b.live ? "实际执行" : "仅预演"],
          ...Wv(b)
        ] }),
        b.attentionMessage && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout danger", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "需要处理" }),
          /* @__PURE__ */ c.jsx("p", { children: b.attentionMessage })
        ] }),
        !b.attentionMessage && b.pausedReason && /* @__PURE__ */ c.jsxs("div", { className: `detail-callout ${b.status === "completed" ? "success" : "warning"}`, children: [
          /* @__PURE__ */ c.jsx("strong", { children: b.status === "completed" ? "任务已完成" : "暂停原因" }),
          /* @__PURE__ */ c.jsx("p", { children: b.pausedReason })
        ] }),
        /* @__PURE__ */ c.jsx("div", { className: "detail-button-row", children: b.actions.map((O) => /* @__PURE__ */ c.jsx(Ee, { disabled: j, className: O === "pause" ? "danger-text" : "", onClick: () => {
          r(b, O);
        }, children: O === "run" ? "立即运行" : O === "pause" ? "暂停任务" : "恢复任务" }, O)) }),
        /* @__PURE__ */ c.jsxs("div", { className: "automation-section-head", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("span", { className: "eyebrow", children: "执行记录" }),
            /* @__PURE__ */ c.jsx("h3", { children: "最近执行" })
          ] }),
          /* @__PURE__ */ c.jsxs("span", { children: [
            b.history.length,
            " 条"
          ] })
        ] }),
        /* @__PURE__ */ c.jsx(Iv, { items: b.history }),
        /* @__PURE__ */ c.jsxs("details", { className: "advanced automation-advanced", children: [
          /* @__PURE__ */ c.jsx("summary", { children: "技术信息" }),
          /* @__PURE__ */ c.jsx("pre", { children: JSON.stringify({ scheduleId: b.source === "schedule" ? b.id : void 0, workId: b.boundWorkId, source: b.source, next: b.nextRunHint, failureCount: b.failureCount, policy: b.policySummary }, null, 2) })
        ] }),
        /* @__PURE__ */ c.jsx("p", { className: "detail-note", children: "这里只展示配置、状态与执行摘要；邮件正文、浏览器 Cookie、登录凭据和 continuation prompt 不会复制到控制台。" })
      ] }) })
    ] })
  ] });
}
function ly(s) {
  return s.advanced?.status ?? "";
}
function Fn(s, j) {
  const _ = ly(s);
  return j === "all" ? !0 : j === "attention" ? _ === "blocked" || _ === "failed" : j === "completed" ? _ === "completed" || _ === "cancelled" : _ === "open" || _ === "running" || _ === "ready";
}
function ty({ data: s, busy: j, onRefresh: _ }) {
  const r = s.workPortfolio, H = r.items ?? [], [D, L] = bl.useState("open"), [Z, N] = bl.useState("all"), [p, M] = bl.useState(), b = bl.useMemo(() => H.filter((O) => Fn(O, D) && (Z === "all" || O.repoId === Z)), [H, D, Z]), C = b.find((O) => O.id === p) ?? b[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "EXECUTION WORK", title: "Work", description: "查看所有已注册仓库的持久 Work；仓库是归属维度，默认聚合展示。", refreshedAt: r.generatedAt, busy: j, onRefresh: _ }),
    /* @__PURE__ */ c.jsxs("div", { className: "toolbar work-toolbar", children: [
      /* @__PURE__ */ c.jsx(Of, { value: D, onChange: L, items: [{ id: "open", label: "Open", count: H.filter((O) => Fn(O, "open")).length }, { id: "attention", label: "Needs attention", count: H.filter((O) => Fn(O, "attention")).length }, { id: "completed", label: "Completed", count: H.filter((O) => Fn(O, "completed")).length }, { id: "all", label: "All", count: H.length }] }),
      /* @__PURE__ */ c.jsxs("label", { className: "repository-filter", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Repository" }),
        /* @__PURE__ */ c.jsxs("select", { value: Z, onChange: (O) => {
          N(O.target.value), M(void 0);
        }, children: [
          /* @__PURE__ */ c.jsx("option", { value: "all", children: "All repositories" }),
          r.repositories.map((O) => /* @__PURE__ */ c.jsx("option", { value: O.repoId, children: O.repositoryName }, O.repoId))
        ] })
      ] })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "scan-list", children: [
        b.map((O) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row work-row ${C?.id === O.id ? "selected" : ""}`, onClick: () => M(O.id), children: [
          /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
            /* @__PURE__ */ c.jsx("span", { className: "row-eyebrow", children: O.repositoryName }),
            /* @__PURE__ */ c.jsx("strong", { children: O.title }),
            /* @__PURE__ */ c.jsx("p", { children: xt(O.latestSummary || O.objective, 108) })
          ] }),
          /* @__PURE__ */ c.jsxs("div", { className: "scan-meta", children: [
            /* @__PURE__ */ c.jsx(Zl, { label: O.statusLabel, tone: O.tone }),
            /* @__PURE__ */ c.jsx("time", { children: we(O.updatedAt) })
          ] })
        ] }, O.id)),
        !b.length && /* @__PURE__ */ c.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Work。" })
      ] }),
      /* @__PURE__ */ c.jsx(li, { title: C?.title, subtitle: C?.objective, empty: "选择一个 Work 查看完整上下文", children: C && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Du, { items: [["Repository", C.repositoryName], ["Status", /* @__PURE__ */ c.jsx(Zl, { label: C.statusLabel, tone: C.tone })], ["Updated", we(C.updatedAt)], ["Work id", /* @__PURE__ */ c.jsx("code", { children: C.id })]] }),
        C.latestSummary && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Latest" }),
          /* @__PURE__ */ c.jsx("p", { children: C.latestSummary })
        ] }),
        /* @__PURE__ */ c.jsx("p", { className: "detail-note", children: "这里聚合所有仓库的持久 Work。具体执行、检查和继续操作仍由 ChatGPT 主控。" })
      ] }) })
    ] })
  ] });
}
function Mu(s) {
  const j = `${s.name} ${s.provider} ${(s.capabilityLabels ?? []).join(" ")}`.toLowerCase();
  return /gmail|calendar|github|google task|notion/.test(j) ? "services" : /browser|desktop|ios|repository|codegraph|local/.test(j) ? "execution" : "extensions";
}
function ey({ data: s, busy: j, onRefresh: _ }) {
  const r = s.commandCenter.plugins ?? [], H = s.automationSettings.providers ?? [], [D, L] = bl.useState("all"), [Z, N] = bl.useState(), p = bl.useMemo(() => r.filter((b) => D === "all" || D === "models" || Mu(b) === D), [r, D]), M = p.find((b) => b.id === Z) ?? p[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "CAPABILITY CATALOG", title: "Capabilities", description: "从“Forge 能做什么”查看扩展、服务、执行能力和模型，而不是浏览 MCP tool 清单。", refreshedAt: s.generatedAt, busy: j, onRefresh: _ }),
    /* @__PURE__ */ c.jsx("div", { className: "toolbar", children: /* @__PURE__ */ c.jsx(Of, { value: D, onChange: L, items: [{ id: "all", label: "All", count: r.length }, { id: "extensions", label: "Extensions", count: r.filter((b) => Mu(b) === "extensions").length }, { id: "services", label: "Services", count: r.filter((b) => Mu(b) === "services").length }, { id: "execution", label: "Execution", count: r.filter((b) => Mu(b) === "execution").length }, { id: "models", label: "Models", count: H.length }] }) }),
    D === "models" ? /* @__PURE__ */ c.jsx("div", { className: "single-list", children: /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: H.map((b) => /* @__PURE__ */ c.jsxs("div", { className: "scan-row static", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
        /* @__PURE__ */ c.jsx("strong", { children: b.displayName }),
        /* @__PURE__ */ c.jsx("p", { children: xt(b.explanation ?? b.summary, 110) })
      ] }),
      /* @__PURE__ */ c.jsx(Zl, { label: b.statusLabel ?? b.status ?? "Unknown", tone: b.status })
    ] }, b.providerId)) }) }) : /* @__PURE__ */ c.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: p.map((b) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row ${M?.id === b.id ? "selected" : ""}`, onClick: () => N(b.id), children: [
        /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ c.jsx("span", { className: "row-eyebrow", children: Mu(b).toUpperCase() }),
          /* @__PURE__ */ c.jsx("strong", { children: b.name }),
          /* @__PURE__ */ c.jsx("p", { children: xt(b.description, 100) })
        ] }),
        /* @__PURE__ */ c.jsx(Zl, { label: b.statusLabel ?? b.status ?? "Unknown", tone: b.status ?? b.tone })
      ] }, b.id)) }),
      /* @__PURE__ */ c.jsx(li, { title: M?.name, subtitle: M?.description, children: M && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Du, { items: [["Status", /* @__PURE__ */ c.jsx(Zl, { label: M.statusLabel ?? M.status ?? "Unknown", tone: M.status ?? M.tone })], ["Provider", M.provider ?? "—"], ["Health", M.healthLabel ?? "—"], ["Lifecycle", M.lifecycleLabel ?? "—"]] }),
        M.nextStep && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Next step" }),
          /* @__PURE__ */ c.jsx("p", { children: M.nextStep })
        ] }),
        (M.capabilityLabels ?? []).length > 0 && /* @__PURE__ */ c.jsx("div", { className: "capability-lines", children: M.capabilityLabels.map((b) => /* @__PURE__ */ c.jsx("span", { children: b }, b)) }),
        (M.warnings ?? []).map((b) => /* @__PURE__ */ c.jsx("div", { className: "detail-callout warning", children: b }, b)),
        /* @__PURE__ */ c.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced · actions & protocol" }),
          /* @__PURE__ */ c.jsx("pre", { children: Pn({ actions: M.actions, advanced: M.advanced }) })
        ] })
      ] }) })
    ] })
  ] });
}
function ay({ value: s, onChange: j, placeholder: _ = "Search…" }) {
  return /* @__PURE__ */ c.jsxs("label", { className: "search-field", children: [
    /* @__PURE__ */ c.jsx(qv, {}),
    /* @__PURE__ */ c.jsx("input", { value: s, onChange: (r) => j(r.target.value), placeholder: _ })
  ] });
}
function uy({ data: s, busy: j, onRefresh: _, onRegister: r, onRemove: H }) {
  const D = s.commandCenter.repositories ?? [], [L, Z] = bl.useState(""), [N, p] = bl.useState(), [M, b] = bl.useState(""), [C, O] = bl.useState(""), [xl, El] = bl.useState(!1), Nl = bl.useMemo(() => D.filter((tl) => `${tl.name} ${tl.path} ${tl.branchLabel}`.toLowerCase().includes(L.toLowerCase())), [D, L]), cl = Nl.find((tl) => tl.id === N) ?? Nl[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "CONTROLLER REGISTRY", title: "Repositories", description: "查看和管理 Forge 的持久化仓库边界；临时目录不需要出现在这里。", refreshedAt: s.generatedAt, busy: j, onRefresh: _, actions: /* @__PURE__ */ c.jsx(Ee, { onClick: () => El((tl) => !tl), "aria-expanded": xl, children: xl ? "Cancel" : "Add repository" }) }),
    /* @__PURE__ */ c.jsxs("div", { className: "repository-tools", children: [
      /* @__PURE__ */ c.jsx(ay, { value: L, onChange: Z, placeholder: "Search repositories…" }),
      /* @__PURE__ */ c.jsx("span", { className: "repository-count", children: Nl.length === D.length ? `${D.length} registered` : `${Nl.length} of ${D.length}` })
    ] }),
    xl && /* @__PURE__ */ c.jsxs("form", { className: "repository-add-panel", onSubmit: (tl) => {
      tl.preventDefault(), M.trim() && r(M.trim(), C.trim() || void 0).then(() => {
        b(""), O(""), El(!1);
      });
    }, children: [
      /* @__PURE__ */ c.jsxs("div", { className: "repository-add-fields", children: [
        /* @__PURE__ */ c.jsxs("label", { children: [
          /* @__PURE__ */ c.jsx("span", { children: "Local path" }),
          /* @__PURE__ */ c.jsx("input", { autoFocus: !0, value: M, onChange: (tl) => b(tl.target.value), placeholder: "/absolute/path" })
        ] }),
        /* @__PURE__ */ c.jsxs("label", { children: [
          /* @__PURE__ */ c.jsx("span", { children: "Display name" }),
          /* @__PURE__ */ c.jsx("input", { value: C, onChange: (tl) => O(tl.target.value), placeholder: "Optional" })
        ] }),
        /* @__PURE__ */ c.jsx(Ee, { type: "submit", disabled: j || !M.trim(), children: "Register" })
      ] }),
      /* @__PURE__ */ c.jsx("p", { children: "只为需要持久化 Work、缓存、并发隔离或发布治理的仓库建立注册项。" })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "split-workspace repository-workspace", children: [
      /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: Nl.map((tl) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row ${cl?.id === tl.id ? "selected" : ""}`, onClick: () => p(tl.id), children: [
        /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ c.jsx("strong", { children: tl.name }),
          /* @__PURE__ */ c.jsx("p", { children: xt(tl.path, 100) })
        ] }),
        /* @__PURE__ */ c.jsxs("div", { className: "scan-meta", children: [
          /* @__PURE__ */ c.jsx(Zl, { label: tl.readinessLabel ?? tl.statusLabel ?? "Registered", tone: tl.readinessLabel ?? tl.statusLabel }),
          /* @__PURE__ */ c.jsx("span", { children: tl.branchLabel ?? "—" })
        ] })
      ] }, tl.id)) }),
      /* @__PURE__ */ c.jsx(li, { title: cl?.name, subtitle: cl?.path, children: cl && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Du, { items: [["Repository id", /* @__PURE__ */ c.jsx("code", { children: cl.id })], ["Branch", cl.branchLabel ?? "—"], ["Working tree", cl.dirtyLabel ?? "—"], ["Readiness", /* @__PURE__ */ c.jsx(Zl, { label: cl.readinessLabel ?? cl.statusLabel ?? "Registered", tone: cl.readinessLabel ?? cl.statusLabel })]] }),
        /* @__PURE__ */ c.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced registry metadata" }),
          /* @__PURE__ */ c.jsx("pre", { children: Pn(cl.advanced) })
        ] }),
        /* @__PURE__ */ c.jsx("div", { className: "detail-button-row", children: /* @__PURE__ */ c.jsx(Ee, { className: "danger-text", disabled: j, onClick: () => {
          H(cl.id);
        }, children: "Remove registry entry" }) })
      ] }) })
    ] })
  ] });
}
function ny({ data: s, busy: j, onRefresh: _, onProviderAction: r, onProviderHealth: H, onToolAction: D, onToolHealth: L }) {
  const Z = s.automationSettings;
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "LONG-LIVED CONFIG", title: "Settings", description: "模型、Provider 与本地工具的长期默认配置。Automation 调度不在这里。", refreshedAt: s.generatedAt, busy: j, onRefresh: _ }),
    /* @__PURE__ */ c.jsxs("div", { className: "settings-column", children: [
      (Z.warnings ?? []).map((N) => /* @__PURE__ */ c.jsx("div", { className: "detail-callout warning", children: N }, N)),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx(In, { title: "Models & routing", meta: `${Z.providers?.length ?? 0} providers` }),
        /* @__PURE__ */ c.jsx("div", { className: "settings-list", children: (Z.providers ?? []).map((N) => /* @__PURE__ */ c.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("strong", { children: N.displayName }),
            /* @__PURE__ */ c.jsx("p", { children: xt(N.explanation ?? N.summary, 120) })
          ] }),
          /* @__PURE__ */ c.jsx(Zl, { label: N.statusLabel ?? N.status ?? "Unknown", tone: N.status }),
          /* @__PURE__ */ c.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ c.jsx(Ee, { disabled: j, onClick: () => {
              H(N);
            }, children: "Check" }),
            /* @__PURE__ */ c.jsx(Ee, { disabled: j, onClick: () => {
              r(N, N.enabled === !1 ? "enable" : "disable");
            }, children: N.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, N.providerId)) })
      ] }),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx(In, { title: "Local tools", meta: `${Z.localTools?.length ?? 0} configured` }),
        /* @__PURE__ */ c.jsx("div", { className: "settings-list", children: (Z.localTools ?? []).map((N) => /* @__PURE__ */ c.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("strong", { children: N.displayName }),
            /* @__PURE__ */ c.jsx("p", { children: xt(N.summary, 120) })
          ] }),
          /* @__PURE__ */ c.jsx(Zl, { label: N.status ?? (N.enabled === !1 ? "Disabled" : "Configured"), tone: N.status }),
          /* @__PURE__ */ c.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ c.jsx(Ee, { disabled: j, onClick: () => {
              L(N);
            }, children: "Check" }),
            /* @__PURE__ */ c.jsx(Ee, { disabled: j, onClick: () => {
              D(N, N.enabled === !1 ? "enable" : "disable");
            }, children: N.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, N.toolId)) })
      ] }),
      /* @__PURE__ */ c.jsxs("details", { className: "advanced", children: [
        /* @__PURE__ */ c.jsx("summary", { children: "Advanced routing & credentials metadata" }),
        /* @__PURE__ */ c.jsx("pre", { children: Pn({ routing: Z.routing, credentials: Z.credentials, overview: Z.overview }) })
      ] })
    ] })
  ] });
}
function iy({ data: s, busy: j, onRefresh: _ }) {
  const [r, H] = bl.useState(), D = s.commandCenter.readiness ?? {};
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "MAINTENANCE", title: "System", description: "低频工程维护入口。正常使用 Forge 不需要理解这里的运行时细节。", refreshedAt: s.generatedAt, busy: j, onRefresh: _ }),
    /* @__PURE__ */ c.jsxs("div", { className: "system-layout", children: [
      /* @__PURE__ */ c.jsxs("section", { className: "system-summary", children: [
        /* @__PURE__ */ c.jsxs("div", { className: "system-posture", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("span", { className: "eyebrow", children: "SYSTEM POSTURE" }),
            /* @__PURE__ */ c.jsx("h2", { children: Ca(D.label ?? D.headline, "Controller state") }),
            /* @__PURE__ */ c.jsx("p", { children: Ca(D.explanation ?? D.summary, "Controller and connector status") })
          ] }),
          /* @__PURE__ */ c.jsx(Zl, { label: Ca(D.state, "Unknown"), tone: Ca(D.state) })
        ] }),
        /* @__PURE__ */ c.jsx(Du, { items: [["Controller", Ca(D.label ?? D.headline, "—")], ["Connector", Ca(s.connector?.status, "—")], ["Repositories", String(s.commandCenter.repositories?.length ?? 0)], ["Plugins", String(s.commandCenter.plugins?.length ?? 0)]] })
      ] }),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx("button", { className: "text-button", onClick: () => {
          at.advanced().then(H);
        }, children: "Load advanced diagnostics" }),
        r && /* @__PURE__ */ c.jsxs("details", { className: "advanced", open: !0, children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced diagnostics" }),
          /* @__PURE__ */ c.jsx("pre", { children: Pn(r) })
        ] })
      ] })
    ] })
  ] });
}
async function Vr() {
  const [s, j, _, r, H, D] = await Promise.all([at.commandCenter(), at.work(), at.workPortfolio(), at.automations(), at.automationSettings(), at.connector().catch(() => {
  })]);
  return { commandCenter: s, work: j, workPortfolio: _, automations: r, automationSettings: H, connector: D, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function cy() {
  const [s, j] = bl.useState(Qr()), [_, r] = bl.useState(), [H, D] = bl.useState(!1), [L, Z] = bl.useState(""), N = bl.useCallback(async () => {
    D(!0), Z("");
    try {
      r(await Vr());
    } catch (C) {
      Z(C instanceof Error ? C.message : String(C));
    } finally {
      D(!1);
    }
  }, []);
  bl.useEffect(() => {
    N();
    const C = () => j(Qr());
    return addEventListener("hashchange", C), () => removeEventListener("hashchange", C);
  }, [N]);
  const p = bl.useCallback(async (C) => {
    D(!0);
    try {
      await C(), r(await Vr());
    } catch (O) {
      Z(O instanceof Error ? O.message : String(O));
    } finally {
      D(!1);
    }
  }, []);
  if (!_) return /* @__PURE__ */ c.jsxs("div", { className: "boot-state", children: [
    /* @__PURE__ */ c.jsx("span", { className: "brand-mark", children: "F" }),
    /* @__PURE__ */ c.jsx("strong", { children: L ? "Forge console unavailable" : "Loading Forge…" }),
    L && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
      /* @__PURE__ */ c.jsx("p", { children: L }),
      /* @__PURE__ */ c.jsx("button", { className: "button", onClick: () => {
        N();
      }, children: "Retry" })
    ] })
  ] });
  const M = { data: _, busy: H, onRefresh: () => {
    N();
  } };
  let b;
  switch (s) {
    case "automations":
      b = /* @__PURE__ */ c.jsx(Pv, { ...M, onAction: (C, O) => p(() => at.automationAction(C.source, C.repoId, C.id, O)) });
      break;
    case "work":
      b = /* @__PURE__ */ c.jsx(ty, { ...M });
      break;
    case "capabilities":
      b = /* @__PURE__ */ c.jsx(ey, { ...M });
      break;
    case "repositories":
      b = /* @__PURE__ */ c.jsx(uy, { ...M, onRegister: (C, O) => p(() => at.registerRepository(C, O)), onRemove: (C) => p(() => at.removeRepository(C)) });
      break;
    case "settings":
      b = /* @__PURE__ */ c.jsx(ny, { ...M, onProviderAction: (C, O) => p(() => at.providerAction(C.providerId, O)), onProviderHealth: (C) => p(() => at.providerHealth(C.providerId)), onToolAction: (C, O) => p(() => at.localToolAction(C.toolId, O)), onToolHealth: (C) => p(() => at.localToolHealth(C.toolId)) });
      break;
    case "system":
      b = /* @__PURE__ */ c.jsx(iy, { ...M });
      break;
    default:
      b = /* @__PURE__ */ c.jsx(Kv, { ...M });
  }
  return /* @__PURE__ */ c.jsxs(Lv, { route: s, children: [
    L && /* @__PURE__ */ c.jsxs("div", { className: "global-error", children: [
      /* @__PURE__ */ c.jsx("strong", { children: "Last action failed" }),
      /* @__PURE__ */ c.jsx("span", { children: L }),
      /* @__PURE__ */ c.jsx("button", { onClick: () => Z(""), children: "×" })
    ] }),
    b
  ] });
}
const Jr = document.getElementById("app");
if (!Jr) throw new Error("Forge console root missing");
xv.createRoot(Jr).render(/* @__PURE__ */ c.jsx(bl.StrictMode, { children: /* @__PURE__ */ c.jsx(cy, {}) }));
