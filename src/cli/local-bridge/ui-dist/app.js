var pf = { exports: {} }, Ou = {};
var Mm;
function hv() {
  if (Mm) return Ou;
  Mm = 1;
  var r = /* @__PURE__ */ Symbol.for("react.transitional.element"), x = /* @__PURE__ */ Symbol.for("react.fragment");
  function M(o, H, C) {
    var X = null;
    if (C !== void 0 && (X = "" + C), H.key !== void 0 && (X = "" + H.key), "key" in H) {
      C = {};
      for (var Z in H)
        Z !== "key" && (C[Z] = H[Z]);
    } else C = H;
    return H = C.ref, {
      $$typeof: r,
      type: o,
      key: X,
      ref: H !== void 0 ? H : null,
      props: C
    };
  }
  return Ou.Fragment = x, Ou.jsx = M, Ou.jsxs = M, Ou;
}
var Dm;
function vv() {
  return Dm || (Dm = 1, pf.exports = hv()), pf.exports;
}
var f = vv(), zf = { exports: {} }, L = {};
var Um;
function yv() {
  if (Um) return L;
  Um = 1;
  var r = /* @__PURE__ */ Symbol.for("react.transitional.element"), x = /* @__PURE__ */ Symbol.for("react.portal"), M = /* @__PURE__ */ Symbol.for("react.fragment"), o = /* @__PURE__ */ Symbol.for("react.strict_mode"), H = /* @__PURE__ */ Symbol.for("react.profiler"), C = /* @__PURE__ */ Symbol.for("react.consumer"), X = /* @__PURE__ */ Symbol.for("react.context"), Z = /* @__PURE__ */ Symbol.for("react.forward_ref"), O = /* @__PURE__ */ Symbol.for("react.suspense"), b = /* @__PURE__ */ Symbol.for("react.memo"), N = /* @__PURE__ */ Symbol.for("react.lazy"), A = /* @__PURE__ */ Symbol.for("react.activity"), _ = Symbol.iterator;
  function ll(m) {
    return m === null || typeof m != "object" ? null : (m = _ && m[_] || m["@@iterator"], typeof m == "function" ? m : null);
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
  }, ul = Object.assign, tl = {};
  function Il(m, E, U) {
    this.props = m, this.context = E, this.refs = tl, this.updater = U || jl;
  }
  Il.prototype.isReactComponent = {}, Il.prototype.setState = function(m, E) {
    if (typeof m != "object" && typeof m != "function" && m != null)
      throw Error(
        "takes an object of state variables to update or a function which returns an object of state variables."
      );
    this.updater.enqueueSetState(this, m, E, "setState");
  }, Il.prototype.forceUpdate = function(m) {
    this.updater.enqueueForceUpdate(this, m, "forceUpdate");
  };
  function la() {
  }
  la.prototype = Il.prototype;
  function Bl(m, E, U) {
    this.props = m, this.context = E, this.refs = tl, this.updater = U || jl;
  }
  var ot = Bl.prototype = new la();
  ot.constructor = Bl, ul(ot, Il.prototype), ot.isPureReactComponent = !0;
  var xt = Array.isArray;
  function Ll() {
  }
  var I = { H: null, A: null, T: null, S: null }, Zl = Object.prototype.hasOwnProperty;
  function _t(m, E, U) {
    var q = U.ref;
    return {
      $$typeof: r,
      type: m,
      key: E,
      ref: q !== void 0 ? q : null,
      props: U
    };
  }
  function Wa(m, E) {
    return _t(m.type, E, m.props);
  }
  function Ot(m) {
    return typeof m == "object" && m !== null && m.$$typeof === r;
  }
  function Vl(m) {
    var E = { "=": "=0", ":": "=2" };
    return "$" + m.replace(/[=:]/g, function(U) {
      return E[U];
    });
  }
  var xa = /\/+/g;
  function Rt(m, E) {
    return typeof m == "object" && m !== null && m.key != null ? Vl("" + m.key) : E.toString(36);
  }
  function At(m) {
    switch (m.status) {
      case "fulfilled":
        return m.value;
      case "rejected":
        throw m.reason;
      default:
        switch (typeof m.status == "string" ? m.then(Ll, Ll) : (m.status = "pending", m.then(
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
  function z(m, E, U, q, V) {
    var w = typeof m;
    (w === "undefined" || w === "boolean") && (m = null);
    var il = !1;
    if (m === null) il = !0;
    else
      switch (w) {
        case "bigint":
        case "string":
        case "number":
          il = !0;
          break;
        case "object":
          switch (m.$$typeof) {
            case r:
            case x:
              il = !0;
              break;
            case N:
              return il = m._init, z(
                il(m._payload),
                E,
                U,
                q,
                V
              );
          }
      }
    if (il)
      return V = V(m), il = q === "" ? "." + Rt(m, 0) : q, xt(V) ? (U = "", il != null && (U = il.replace(xa, "$&/") + "/"), z(V, E, U, "", function(He) {
        return He;
      })) : V != null && (Ot(V) && (V = Wa(
        V,
        U + (V.key == null || m && m.key === V.key ? "" : ("" + V.key).replace(
          xa,
          "$&/"
        ) + "/") + il
      )), E.push(V)), 1;
    il = 0;
    var Gl = q === "" ? "." : q + ":";
    if (xt(m))
      for (var zl = 0; zl < m.length; zl++)
        q = m[zl], w = Gl + Rt(q, zl), il += z(
          q,
          E,
          U,
          w,
          V
        );
    else if (zl = ll(m), typeof zl == "function")
      for (m = zl.call(m), zl = 0; !(q = m.next()).done; )
        q = q.value, w = Gl + Rt(q, zl++), il += z(
          q,
          E,
          U,
          w,
          V
        );
    else if (w === "object") {
      if (typeof m.then == "function")
        return z(
          At(m),
          E,
          U,
          q,
          V
        );
      throw E = String(m), Error(
        "Objects are not valid as a React child (found: " + (E === "[object Object]" ? "object with keys {" + Object.keys(m).join(", ") + "}" : E) + "). If you meant to render a collection of children, use an array instead."
      );
    }
    return il;
  }
  function D(m, E, U) {
    if (m == null) return m;
    var q = [], V = 0;
    return z(m, q, "", "", function(w) {
      return E.call(U, w, V++);
    }), q;
  }
  function Q(m) {
    if (m._status === -1) {
      var E = m._result;
      E = E(), E.then(
        function(U) {
          (m._status === 0 || m._status === -1) && (m._status = 1, m._result = U);
        },
        function(U) {
          (m._status === 0 || m._status === -1) && (m._status = 2, m._result = U);
        }
      ), m._status === -1 && (m._status = 0, m._result = E);
    }
    if (m._status === 1) return m._result.default;
    throw m._result;
  }
  var sl = typeof reportError == "function" ? reportError : function(m) {
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
  }, rl = {
    map: D,
    forEach: function(m, E, U) {
      D(
        m,
        function() {
          E.apply(this, arguments);
        },
        U
      );
    },
    count: function(m) {
      var E = 0;
      return D(m, function() {
        E++;
      }), E;
    },
    toArray: function(m) {
      return D(m, function(E) {
        return E;
      }) || [];
    },
    only: function(m) {
      if (!Ot(m))
        throw Error(
          "React.Children.only expected to receive a single React element child."
        );
      return m;
    }
  };
  return L.Activity = A, L.Children = rl, L.Component = Il, L.Fragment = M, L.Profiler = H, L.PureComponent = Bl, L.StrictMode = o, L.Suspense = O, L.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = I, L.__COMPILER_RUNTIME = {
    __proto__: null,
    c: function(m) {
      return I.H.useMemoCache(m);
    }
  }, L.cache = function(m) {
    return function() {
      return m.apply(null, arguments);
    };
  }, L.cacheSignal = function() {
    return null;
  }, L.cloneElement = function(m, E, U) {
    if (m == null)
      throw Error(
        "The argument must be a React element, but you passed " + m + "."
      );
    var q = ul({}, m.props), V = m.key;
    if (E != null)
      for (w in E.key !== void 0 && (V = "" + E.key), E)
        !Zl.call(E, w) || w === "key" || w === "__self" || w === "__source" || w === "ref" && E.ref === void 0 || (q[w] = E[w]);
    var w = arguments.length - 2;
    if (w === 1) q.children = U;
    else if (1 < w) {
      for (var il = Array(w), Gl = 0; Gl < w; Gl++)
        il[Gl] = arguments[Gl + 2];
      q.children = il;
    }
    return _t(m.type, V, q);
  }, L.createContext = function(m) {
    return m = {
      $$typeof: X,
      _currentValue: m,
      _currentValue2: m,
      _threadCount: 0,
      Provider: null,
      Consumer: null
    }, m.Provider = m, m.Consumer = {
      $$typeof: C,
      _context: m
    }, m;
  }, L.createElement = function(m, E, U) {
    var q, V = {}, w = null;
    if (E != null)
      for (q in E.key !== void 0 && (w = "" + E.key), E)
        Zl.call(E, q) && q !== "key" && q !== "__self" && q !== "__source" && (V[q] = E[q]);
    var il = arguments.length - 2;
    if (il === 1) V.children = U;
    else if (1 < il) {
      for (var Gl = Array(il), zl = 0; zl < il; zl++)
        Gl[zl] = arguments[zl + 2];
      V.children = Gl;
    }
    if (m && m.defaultProps)
      for (q in il = m.defaultProps, il)
        V[q] === void 0 && (V[q] = il[q]);
    return _t(m, w, V);
  }, L.createRef = function() {
    return { current: null };
  }, L.forwardRef = function(m) {
    return { $$typeof: Z, render: m };
  }, L.isValidElement = Ot, L.lazy = function(m) {
    return {
      $$typeof: N,
      _payload: { _status: -1, _result: m },
      _init: Q
    };
  }, L.memo = function(m, E) {
    return {
      $$typeof: b,
      type: m,
      compare: E === void 0 ? null : E
    };
  }, L.startTransition = function(m) {
    var E = I.T, U = {};
    I.T = U;
    try {
      var q = m(), V = I.S;
      V !== null && V(U, q), typeof q == "object" && q !== null && typeof q.then == "function" && q.then(Ll, sl);
    } catch (w) {
      sl(w);
    } finally {
      E !== null && U.types !== null && (E.types = U.types), I.T = E;
    }
  }, L.unstable_useCacheRefresh = function() {
    return I.H.useCacheRefresh();
  }, L.use = function(m) {
    return I.H.use(m);
  }, L.useActionState = function(m, E, U) {
    return I.H.useActionState(m, E, U);
  }, L.useCallback = function(m, E) {
    return I.H.useCallback(m, E);
  }, L.useContext = function(m) {
    return I.H.useContext(m);
  }, L.useDebugValue = function() {
  }, L.useDeferredValue = function(m, E) {
    return I.H.useDeferredValue(m, E);
  }, L.useEffect = function(m, E) {
    return I.H.useEffect(m, E);
  }, L.useEffectEvent = function(m) {
    return I.H.useEffectEvent(m);
  }, L.useId = function() {
    return I.H.useId();
  }, L.useImperativeHandle = function(m, E, U) {
    return I.H.useImperativeHandle(m, E, U);
  }, L.useInsertionEffect = function(m, E) {
    return I.H.useInsertionEffect(m, E);
  }, L.useLayoutEffect = function(m, E) {
    return I.H.useLayoutEffect(m, E);
  }, L.useMemo = function(m, E) {
    return I.H.useMemo(m, E);
  }, L.useOptimistic = function(m, E) {
    return I.H.useOptimistic(m, E);
  }, L.useReducer = function(m, E, U) {
    return I.H.useReducer(m, E, U);
  }, L.useRef = function(m) {
    return I.H.useRef(m);
  }, L.useState = function(m) {
    return I.H.useState(m);
  }, L.useSyncExternalStore = function(m, E, U) {
    return I.H.useSyncExternalStore(
      m,
      E,
      U
    );
  }, L.useTransition = function() {
    return I.H.useTransition();
  }, L.version = "19.2.8", L;
}
var Rm;
function xf() {
  return Rm || (Rm = 1, zf.exports = yv()), zf.exports;
}
var Sl = xf(), Af = { exports: {} }, Nu = {}, Tf = { exports: {} }, jf = {};
var Cm;
function gv() {
  return Cm || (Cm = 1, (function(r) {
    function x(z, D) {
      var Q = z.length;
      z.push(D);
      l: for (; 0 < Q; ) {
        var sl = Q - 1 >>> 1, rl = z[sl];
        if (0 < H(rl, D))
          z[sl] = D, z[Q] = rl, Q = sl;
        else break l;
      }
    }
    function M(z) {
      return z.length === 0 ? null : z[0];
    }
    function o(z) {
      if (z.length === 0) return null;
      var D = z[0], Q = z.pop();
      if (Q !== D) {
        z[0] = Q;
        l: for (var sl = 0, rl = z.length, m = rl >>> 1; sl < m; ) {
          var E = 2 * (sl + 1) - 1, U = z[E], q = E + 1, V = z[q];
          if (0 > H(U, Q))
            q < rl && 0 > H(V, U) ? (z[sl] = V, z[q] = Q, sl = q) : (z[sl] = U, z[E] = Q, sl = E);
          else if (q < rl && 0 > H(V, Q))
            z[sl] = V, z[q] = Q, sl = q;
          else break l;
        }
      }
      return D;
    }
    function H(z, D) {
      var Q = z.sortIndex - D.sortIndex;
      return Q !== 0 ? Q : z.id - D.id;
    }
    if (r.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
      var C = performance;
      r.unstable_now = function() {
        return C.now();
      };
    } else {
      var X = Date, Z = X.now();
      r.unstable_now = function() {
        return X.now() - Z;
      };
    }
    var O = [], b = [], N = 1, A = null, _ = 3, ll = !1, jl = !1, ul = !1, tl = !1, Il = typeof setTimeout == "function" ? setTimeout : null, la = typeof clearTimeout == "function" ? clearTimeout : null, Bl = typeof setImmediate < "u" ? setImmediate : null;
    function ot(z) {
      for (var D = M(b); D !== null; ) {
        if (D.callback === null) o(b);
        else if (D.startTime <= z)
          o(b), D.sortIndex = D.expirationTime, x(O, D);
        else break;
        D = M(b);
      }
    }
    function xt(z) {
      if (ul = !1, ot(z), !jl)
        if (M(O) !== null)
          jl = !0, Ll || (Ll = !0, Vl());
        else {
          var D = M(b);
          D !== null && At(xt, D.startTime - z);
        }
    }
    var Ll = !1, I = -1, Zl = 5, _t = -1;
    function Wa() {
      return tl ? !0 : !(r.unstable_now() - _t < Zl);
    }
    function Ot() {
      if (tl = !1, Ll) {
        var z = r.unstable_now();
        _t = z;
        var D = !0;
        try {
          l: {
            jl = !1, ul && (ul = !1, la(I), I = -1), ll = !0;
            var Q = _;
            try {
              t: {
                for (ot(z), A = M(O); A !== null && !(A.expirationTime > z && Wa()); ) {
                  var sl = A.callback;
                  if (typeof sl == "function") {
                    A.callback = null, _ = A.priorityLevel;
                    var rl = sl(
                      A.expirationTime <= z
                    );
                    if (z = r.unstable_now(), typeof rl == "function") {
                      A.callback = rl, ot(z), D = !0;
                      break t;
                    }
                    A === M(O) && o(O), ot(z);
                  } else o(O);
                  A = M(O);
                }
                if (A !== null) D = !0;
                else {
                  var m = M(b);
                  m !== null && At(
                    xt,
                    m.startTime - z
                  ), D = !1;
                }
              }
              break l;
            } finally {
              A = null, _ = Q, ll = !1;
            }
            D = void 0;
          }
        } finally {
          D ? Vl() : Ll = !1;
        }
      }
    }
    var Vl;
    if (typeof Bl == "function")
      Vl = function() {
        Bl(Ot);
      };
    else if (typeof MessageChannel < "u") {
      var xa = new MessageChannel(), Rt = xa.port2;
      xa.port1.onmessage = Ot, Vl = function() {
        Rt.postMessage(null);
      };
    } else
      Vl = function() {
        Il(Ot, 0);
      };
    function At(z, D) {
      I = Il(function() {
        z(r.unstable_now());
      }, D);
    }
    r.unstable_IdlePriority = 5, r.unstable_ImmediatePriority = 1, r.unstable_LowPriority = 4, r.unstable_NormalPriority = 3, r.unstable_Profiling = null, r.unstable_UserBlockingPriority = 2, r.unstable_cancelCallback = function(z) {
      z.callback = null;
    }, r.unstable_forceFrameRate = function(z) {
      0 > z || 125 < z ? console.error(
        "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
      ) : Zl = 0 < z ? Math.floor(1e3 / z) : 5;
    }, r.unstable_getCurrentPriorityLevel = function() {
      return _;
    }, r.unstable_next = function(z) {
      switch (_) {
        case 1:
        case 2:
        case 3:
          var D = 3;
          break;
        default:
          D = _;
      }
      var Q = _;
      _ = D;
      try {
        return z();
      } finally {
        _ = Q;
      }
    }, r.unstable_requestPaint = function() {
      tl = !0;
    }, r.unstable_runWithPriority = function(z, D) {
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
      var Q = _;
      _ = z;
      try {
        return D();
      } finally {
        _ = Q;
      }
    }, r.unstable_scheduleCallback = function(z, D, Q) {
      var sl = r.unstable_now();
      switch (typeof Q == "object" && Q !== null ? (Q = Q.delay, Q = typeof Q == "number" && 0 < Q ? sl + Q : sl) : Q = sl, z) {
        case 1:
          var rl = -1;
          break;
        case 2:
          rl = 250;
          break;
        case 5:
          rl = 1073741823;
          break;
        case 4:
          rl = 1e4;
          break;
        default:
          rl = 5e3;
      }
      return rl = Q + rl, z = {
        id: N++,
        callback: D,
        priorityLevel: z,
        startTime: Q,
        expirationTime: rl,
        sortIndex: -1
      }, Q > sl ? (z.sortIndex = Q, x(b, z), M(O) === null && z === M(b) && (ul ? (la(I), I = -1) : ul = !0, At(xt, Q - sl))) : (z.sortIndex = rl, x(O, z), jl || ll || (jl = !0, Ll || (Ll = !0, Vl()))), z;
    }, r.unstable_shouldYield = Wa, r.unstable_wrapCallback = function(z) {
      var D = _;
      return function() {
        var Q = _;
        _ = D;
        try {
          return z.apply(this, arguments);
        } finally {
          _ = Q;
        }
      };
    };
  })(jf)), jf;
}
var Hm;
function Sv() {
  return Hm || (Hm = 1, Tf.exports = gv()), Tf.exports;
}
var Ef = { exports: {} }, Yl = {};
var qm;
function bv() {
  if (qm) return Yl;
  qm = 1;
  var r = xf();
  function x(O) {
    var b = "https://react.dev/errors/" + O;
    if (1 < arguments.length) {
      b += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var N = 2; N < arguments.length; N++)
        b += "&args[]=" + encodeURIComponent(arguments[N]);
    }
    return "Minified React error #" + O + "; visit " + b + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function M() {
  }
  var o = {
    d: {
      f: M,
      r: function() {
        throw Error(x(522));
      },
      D: M,
      C: M,
      L: M,
      m: M,
      X: M,
      S: M,
      M
    },
    p: 0,
    findDOMNode: null
  }, H = /* @__PURE__ */ Symbol.for("react.portal");
  function C(O, b, N) {
    var A = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: H,
      key: A == null ? null : "" + A,
      children: O,
      containerInfo: b,
      implementation: N
    };
  }
  var X = r.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function Z(O, b) {
    if (O === "font") return "";
    if (typeof b == "string")
      return b === "use-credentials" ? b : "";
  }
  return Yl.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = o, Yl.createPortal = function(O, b) {
    var N = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!b || b.nodeType !== 1 && b.nodeType !== 9 && b.nodeType !== 11)
      throw Error(x(299));
    return C(O, b, null, N);
  }, Yl.flushSync = function(O) {
    var b = X.T, N = o.p;
    try {
      if (X.T = null, o.p = 2, O) return O();
    } finally {
      X.T = b, o.p = N, o.d.f();
    }
  }, Yl.preconnect = function(O, b) {
    typeof O == "string" && (b ? (b = b.crossOrigin, b = typeof b == "string" ? b === "use-credentials" ? b : "" : void 0) : b = null, o.d.C(O, b));
  }, Yl.prefetchDNS = function(O) {
    typeof O == "string" && o.d.D(O);
  }, Yl.preinit = function(O, b) {
    if (typeof O == "string" && b && typeof b.as == "string") {
      var N = b.as, A = Z(N, b.crossOrigin), _ = typeof b.integrity == "string" ? b.integrity : void 0, ll = typeof b.fetchPriority == "string" ? b.fetchPriority : void 0;
      N === "style" ? o.d.S(
        O,
        typeof b.precedence == "string" ? b.precedence : void 0,
        {
          crossOrigin: A,
          integrity: _,
          fetchPriority: ll
        }
      ) : N === "script" && o.d.X(O, {
        crossOrigin: A,
        integrity: _,
        fetchPriority: ll,
        nonce: typeof b.nonce == "string" ? b.nonce : void 0
      });
    }
  }, Yl.preinitModule = function(O, b) {
    if (typeof O == "string")
      if (typeof b == "object" && b !== null) {
        if (b.as == null || b.as === "script") {
          var N = Z(
            b.as,
            b.crossOrigin
          );
          o.d.M(O, {
            crossOrigin: N,
            integrity: typeof b.integrity == "string" ? b.integrity : void 0,
            nonce: typeof b.nonce == "string" ? b.nonce : void 0
          });
        }
      } else b == null && o.d.M(O);
  }, Yl.preload = function(O, b) {
    if (typeof O == "string" && typeof b == "object" && b !== null && typeof b.as == "string") {
      var N = b.as, A = Z(N, b.crossOrigin);
      o.d.L(O, N, {
        crossOrigin: A,
        integrity: typeof b.integrity == "string" ? b.integrity : void 0,
        nonce: typeof b.nonce == "string" ? b.nonce : void 0,
        type: typeof b.type == "string" ? b.type : void 0,
        fetchPriority: typeof b.fetchPriority == "string" ? b.fetchPriority : void 0,
        referrerPolicy: typeof b.referrerPolicy == "string" ? b.referrerPolicy : void 0,
        imageSrcSet: typeof b.imageSrcSet == "string" ? b.imageSrcSet : void 0,
        imageSizes: typeof b.imageSizes == "string" ? b.imageSizes : void 0,
        media: typeof b.media == "string" ? b.media : void 0
      });
    }
  }, Yl.preloadModule = function(O, b) {
    if (typeof O == "string")
      if (b) {
        var N = Z(b.as, b.crossOrigin);
        o.d.m(O, {
          as: typeof b.as == "string" && b.as !== "script" ? b.as : void 0,
          crossOrigin: N,
          integrity: typeof b.integrity == "string" ? b.integrity : void 0
        });
      } else o.d.m(O);
  }, Yl.requestFormReset = function(O) {
    o.d.r(O);
  }, Yl.unstable_batchedUpdates = function(O, b) {
    return O(b);
  }, Yl.useFormState = function(O, b, N) {
    return X.H.useFormState(O, b, N);
  }, Yl.useFormStatus = function() {
    return X.H.useHostTransitionStatus();
  }, Yl.version = "19.2.8", Yl;
}
var Bm;
function pv() {
  if (Bm) return Ef.exports;
  Bm = 1;
  function r() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(r);
      } catch (x) {
        console.error(x);
      }
  }
  return r(), Ef.exports = bv(), Ef.exports;
}
var Ym;
function zv() {
  if (Ym) return Nu;
  Ym = 1;
  var r = Sv(), x = xf(), M = pv();
  function o(l) {
    var t = "https://react.dev/errors/" + l;
    if (1 < arguments.length) {
      t += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var a = 2; a < arguments.length; a++)
        t += "&args[]=" + encodeURIComponent(arguments[a]);
    }
    return "Minified React error #" + l + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function H(l) {
    return !(!l || l.nodeType !== 1 && l.nodeType !== 9 && l.nodeType !== 11);
  }
  function C(l) {
    var t = l, a = l;
    if (l.alternate) for (; t.return; ) t = t.return;
    else {
      l = t;
      do
        t = l, (t.flags & 4098) !== 0 && (a = t.return), l = t.return;
      while (l);
    }
    return t.tag === 3 ? a : null;
  }
  function X(l) {
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
  function O(l) {
    if (C(l) !== l)
      throw Error(o(188));
  }
  function b(l) {
    var t = l.alternate;
    if (!t) {
      if (t = C(l), t === null) throw Error(o(188));
      return t !== l ? null : l;
    }
    for (var a = l, e = t; ; ) {
      var u = a.return;
      if (u === null) break;
      var n = u.alternate;
      if (n === null) {
        if (e = u.return, e !== null) {
          a = e;
          continue;
        }
        break;
      }
      if (u.child === n.child) {
        for (n = u.child; n; ) {
          if (n === a) return O(u), l;
          if (n === e) return O(u), t;
          n = n.sibling;
        }
        throw Error(o(188));
      }
      if (a.return !== e.return) a = u, e = n;
      else {
        for (var i = !1, c = u.child; c; ) {
          if (c === a) {
            i = !0, a = u, e = n;
            break;
          }
          if (c === e) {
            i = !0, e = u, a = n;
            break;
          }
          c = c.sibling;
        }
        if (!i) {
          for (c = n.child; c; ) {
            if (c === a) {
              i = !0, a = n, e = u;
              break;
            }
            if (c === e) {
              i = !0, e = n, a = u;
              break;
            }
            c = c.sibling;
          }
          if (!i) throw Error(o(189));
        }
      }
      if (a.alternate !== e) throw Error(o(190));
    }
    if (a.tag !== 3) throw Error(o(188));
    return a.stateNode.current === a ? l : t;
  }
  function N(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l;
    for (l = l.child; l !== null; ) {
      if (t = N(l), t !== null) return t;
      l = l.sibling;
    }
    return null;
  }
  var A = Object.assign, _ = /* @__PURE__ */ Symbol.for("react.element"), ll = /* @__PURE__ */ Symbol.for("react.transitional.element"), jl = /* @__PURE__ */ Symbol.for("react.portal"), ul = /* @__PURE__ */ Symbol.for("react.fragment"), tl = /* @__PURE__ */ Symbol.for("react.strict_mode"), Il = /* @__PURE__ */ Symbol.for("react.profiler"), la = /* @__PURE__ */ Symbol.for("react.consumer"), Bl = /* @__PURE__ */ Symbol.for("react.context"), ot = /* @__PURE__ */ Symbol.for("react.forward_ref"), xt = /* @__PURE__ */ Symbol.for("react.suspense"), Ll = /* @__PURE__ */ Symbol.for("react.suspense_list"), I = /* @__PURE__ */ Symbol.for("react.memo"), Zl = /* @__PURE__ */ Symbol.for("react.lazy"), _t = /* @__PURE__ */ Symbol.for("react.activity"), Wa = /* @__PURE__ */ Symbol.for("react.memo_cache_sentinel"), Ot = Symbol.iterator;
  function Vl(l) {
    return l === null || typeof l != "object" ? null : (l = Ot && l[Ot] || l["@@iterator"], typeof l == "function" ? l : null);
  }
  var xa = /* @__PURE__ */ Symbol.for("react.client.reference");
  function Rt(l) {
    if (l == null) return null;
    if (typeof l == "function")
      return l.$$typeof === xa ? null : l.displayName || l.name || null;
    if (typeof l == "string") return l;
    switch (l) {
      case ul:
        return "Fragment";
      case Il:
        return "Profiler";
      case tl:
        return "StrictMode";
      case xt:
        return "Suspense";
      case Ll:
        return "SuspenseList";
      case _t:
        return "Activity";
    }
    if (typeof l == "object")
      switch (l.$$typeof) {
        case jl:
          return "Portal";
        case Bl:
          return l.displayName || "Context";
        case la:
          return (l._context.displayName || "Context") + ".Consumer";
        case ot:
          var t = l.render;
          return l = l.displayName, l || (l = t.displayName || t.name || "", l = l !== "" ? "ForwardRef(" + l + ")" : "ForwardRef"), l;
        case I:
          return t = l.displayName || null, t !== null ? t : Rt(l.type) || "Memo";
        case Zl:
          t = l._payload, l = l._init;
          try {
            return Rt(l(t));
          } catch {
          }
      }
    return null;
  }
  var At = Array.isArray, z = x.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, D = M.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, Q = {
    pending: !1,
    data: null,
    method: null,
    action: null
  }, sl = [], rl = -1;
  function m(l) {
    return { current: l };
  }
  function E(l) {
    0 > rl || (l.current = sl[rl], sl[rl] = null, rl--);
  }
  function U(l, t) {
    rl++, sl[rl] = l.current, l.current = t;
  }
  var q = m(null), V = m(null), w = m(null), il = m(null);
  function Gl(l, t) {
    switch (U(w, t), U(V, l), U(q, null), t.nodeType) {
      case 9:
      case 11:
        l = (l = t.documentElement) && (l = l.namespaceURI) ? Po(l) : 0;
        break;
      default:
        if (l = t.tagName, t = t.namespaceURI)
          t = Po(t), l = lm(t, l);
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
    E(q), U(q, l);
  }
  function zl() {
    E(q), E(V), E(w);
  }
  function He(l) {
    l.memoizedState !== null && U(il, l);
    var t = q.current, a = lm(t, l.type);
    t !== a && (U(V, l), U(q, a));
  }
  function Uu(l) {
    V.current === l && (E(q), E(V)), il.current === l && (E(il), ju._currentValue = Q);
  }
  var ti, Of;
  function _a(l) {
    if (ti === void 0)
      try {
        throw Error();
      } catch (a) {
        var t = a.stack.trim().match(/\n( *(at )?)/);
        ti = t && t[1] || "", Of = -1 < a.stack.indexOf(`
    at`) ? " (<anonymous>)" : -1 < a.stack.indexOf("@") ? "@unknown:0:0" : "";
      }
    return `
` + ti + l + Of;
  }
  var ai = !1;
  function ei(l, t) {
    if (!l || ai) return "";
    ai = !0;
    var a = Error.prepareStackTrace;
    Error.prepareStackTrace = void 0;
    try {
      var e = {
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
      e.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
      var u = Object.getOwnPropertyDescriptor(
        e.DetermineComponentFrameRoot,
        "name"
      );
      u && u.configurable && Object.defineProperty(
        e.DetermineComponentFrameRoot,
        "name",
        { value: "DetermineComponentFrameRoot" }
      );
      var n = e.DetermineComponentFrameRoot(), i = n[0], c = n[1];
      if (i && c) {
        var s = i.split(`
`), y = c.split(`
`);
        for (u = e = 0; e < s.length && !s[e].includes("DetermineComponentFrameRoot"); )
          e++;
        for (; u < y.length && !y[u].includes(
          "DetermineComponentFrameRoot"
        ); )
          u++;
        if (e === s.length || u === y.length)
          for (e = s.length - 1, u = y.length - 1; 1 <= e && 0 <= u && s[e] !== y[u]; )
            u--;
        for (; 1 <= e && 0 <= u; e--, u--)
          if (s[e] !== y[u]) {
            if (e !== 1 || u !== 1)
              do
                if (e--, u--, 0 > u || s[e] !== y[u]) {
                  var p = `
` + s[e].replace(" at new ", " at ");
                  return l.displayName && p.includes("<anonymous>") && (p = p.replace("<anonymous>", l.displayName)), p;
                }
              while (1 <= e && 0 <= u);
            break;
          }
      }
    } finally {
      ai = !1, Error.prepareStackTrace = a;
    }
    return (a = l ? l.displayName || l.name : "") ? _a(a) : "";
  }
  function Km(l, t) {
    switch (l.tag) {
      case 26:
      case 27:
      case 5:
        return _a(l.type);
      case 16:
        return _a("Lazy");
      case 13:
        return l.child !== t && t !== null ? _a("Suspense Fallback") : _a("Suspense");
      case 19:
        return _a("SuspenseList");
      case 0:
      case 15:
        return ei(l.type, !1);
      case 11:
        return ei(l.type.render, !1);
      case 1:
        return ei(l.type, !0);
      case 31:
        return _a("Activity");
      default:
        return "";
    }
  }
  function Nf(l) {
    try {
      var t = "", a = null;
      do
        t += Km(l, a), a = l, l = l.return;
      while (l);
      return t;
    } catch (e) {
      return `
Error generating stack: ` + e.message + `
` + e.stack;
    }
  }
  var ui = Object.prototype.hasOwnProperty, ni = r.unstable_scheduleCallback, ii = r.unstable_cancelCallback, Jm = r.unstable_shouldYield, wm = r.unstable_requestPaint, Pl = r.unstable_now, $m = r.unstable_getCurrentPriorityLevel, Mf = r.unstable_ImmediatePriority, Df = r.unstable_UserBlockingPriority, Ru = r.unstable_NormalPriority, Wm = r.unstable_LowPriority, Uf = r.unstable_IdlePriority, km = r.log, Fm = r.unstable_setDisableYieldValue, qe = null, lt = null;
  function ta(l) {
    if (typeof km == "function" && Fm(l), lt && typeof lt.setStrictMode == "function")
      try {
        lt.setStrictMode(qe, l);
      } catch {
      }
  }
  var tt = Math.clz32 ? Math.clz32 : lr, Im = Math.log, Pm = Math.LN2;
  function lr(l) {
    return l >>>= 0, l === 0 ? 32 : 31 - (Im(l) / Pm | 0) | 0;
  }
  var Cu = 256, Hu = 262144, qu = 4194304;
  function Oa(l) {
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
  function Bu(l, t, a) {
    var e = l.pendingLanes;
    if (e === 0) return 0;
    var u = 0, n = l.suspendedLanes, i = l.pingedLanes;
    l = l.warmLanes;
    var c = e & 134217727;
    return c !== 0 ? (e = c & ~n, e !== 0 ? u = Oa(e) : (i &= c, i !== 0 ? u = Oa(i) : a || (a = c & ~l, a !== 0 && (u = Oa(a))))) : (c = e & ~n, c !== 0 ? u = Oa(c) : i !== 0 ? u = Oa(i) : a || (a = e & ~l, a !== 0 && (u = Oa(a)))), u === 0 ? 0 : t !== 0 && t !== u && (t & n) === 0 && (n = u & -u, a = t & -t, n >= a || n === 32 && (a & 4194048) !== 0) ? t : u;
  }
  function Be(l, t) {
    return (l.pendingLanes & ~(l.suspendedLanes & ~l.pingedLanes) & t) === 0;
  }
  function tr(l, t) {
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
    var l = qu;
    return qu <<= 1, (qu & 62914560) === 0 && (qu = 4194304), l;
  }
  function ci(l) {
    for (var t = [], a = 0; 31 > a; a++) t.push(l);
    return t;
  }
  function Ye(l, t) {
    l.pendingLanes |= t, t !== 268435456 && (l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0);
  }
  function ar(l, t, a, e, u, n) {
    var i = l.pendingLanes;
    l.pendingLanes = a, l.suspendedLanes = 0, l.pingedLanes = 0, l.warmLanes = 0, l.expiredLanes &= a, l.entangledLanes &= a, l.errorRecoveryDisabledLanes &= a, l.shellSuspendCounter = 0;
    var c = l.entanglements, s = l.expirationTimes, y = l.hiddenUpdates;
    for (a = i & ~a; 0 < a; ) {
      var p = 31 - tt(a), j = 1 << p;
      c[p] = 0, s[p] = -1;
      var g = y[p];
      if (g !== null)
        for (y[p] = null, p = 0; p < g.length; p++) {
          var S = g[p];
          S !== null && (S.lane &= -536870913);
        }
      a &= ~j;
    }
    e !== 0 && Cf(l, e, 0), n !== 0 && u === 0 && l.tag !== 0 && (l.suspendedLanes |= n & ~(i & ~t));
  }
  function Cf(l, t, a) {
    l.pendingLanes |= t, l.suspendedLanes &= ~t;
    var e = 31 - tt(t);
    l.entangledLanes |= t, l.entanglements[e] = l.entanglements[e] | 1073741824 | a & 261930;
  }
  function Hf(l, t) {
    var a = l.entangledLanes |= t;
    for (l = l.entanglements; a; ) {
      var e = 31 - tt(a), u = 1 << e;
      u & t | l[e] & t && (l[e] |= t), a &= ~u;
    }
  }
  function qf(l, t) {
    var a = t & -t;
    return a = (a & 42) !== 0 ? 1 : fi(a), (a & (l.suspendedLanes | t)) !== 0 ? 0 : a;
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
  function Bf() {
    var l = D.p;
    return l !== 0 ? l : (l = window.event, l === void 0 ? 32 : Tm(l.type));
  }
  function Yf(l, t) {
    var a = D.p;
    try {
      return D.p = l, t();
    } finally {
      D.p = a;
    }
  }
  var aa = Math.random().toString(36).slice(2), Ul = "__reactFiber$" + aa, Kl = "__reactProps$" + aa, ka = "__reactContainer$" + aa, di = "__reactEvents$" + aa, er = "__reactListeners$" + aa, ur = "__reactHandles$" + aa, Gf = "__reactResources$" + aa, Ge = "__reactMarker$" + aa;
  function oi(l) {
    delete l[Ul], delete l[Kl], delete l[di], delete l[er], delete l[ur];
  }
  function Fa(l) {
    var t = l[Ul];
    if (t) return t;
    for (var a = l.parentNode; a; ) {
      if (t = a[ka] || a[Ul]) {
        if (a = t.alternate, t.child !== null || a !== null && a.child !== null)
          for (l = cm(l); l !== null; ) {
            if (a = l[Ul]) return a;
            l = cm(l);
          }
        return t;
      }
      l = a, a = l.parentNode;
    }
    return null;
  }
  function Ia(l) {
    if (l = l[Ul] || l[ka]) {
      var t = l.tag;
      if (t === 5 || t === 6 || t === 13 || t === 31 || t === 26 || t === 27 || t === 3)
        return l;
    }
    return null;
  }
  function Qe(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l.stateNode;
    throw Error(o(33));
  }
  function Pa(l) {
    var t = l[Gf];
    return t || (t = l[Gf] = { hoistableStyles: /* @__PURE__ */ new Map(), hoistableScripts: /* @__PURE__ */ new Map() }), t;
  }
  function Ml(l) {
    l[Ge] = !0;
  }
  var Qf = /* @__PURE__ */ new Set(), Xf = {};
  function Na(l, t) {
    le(l, t), le(l + "Capture", t);
  }
  function le(l, t) {
    for (Xf[l] = t, l = 0; l < t.length; l++)
      Qf.add(t[l]);
  }
  var nr = RegExp(
    "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"
  ), Lf = {}, Zf = {};
  function ir(l) {
    return ui.call(Zf, l) ? !0 : ui.call(Lf, l) ? !1 : nr.test(l) ? Zf[l] = !0 : (Lf[l] = !0, !1);
  }
  function Yu(l, t, a) {
    if (ir(t))
      if (a === null) l.removeAttribute(t);
      else {
        switch (typeof a) {
          case "undefined":
          case "function":
          case "symbol":
            l.removeAttribute(t);
            return;
          case "boolean":
            var e = t.toLowerCase().slice(0, 5);
            if (e !== "data-" && e !== "aria-") {
              l.removeAttribute(t);
              return;
            }
        }
        l.setAttribute(t, "" + a);
      }
  }
  function Gu(l, t, a) {
    if (a === null) l.removeAttribute(t);
    else {
      switch (typeof a) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          l.removeAttribute(t);
          return;
      }
      l.setAttribute(t, "" + a);
    }
  }
  function Ct(l, t, a, e) {
    if (e === null) l.removeAttribute(a);
    else {
      switch (typeof e) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          l.removeAttribute(a);
          return;
      }
      l.setAttributeNS(t, a, "" + e);
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
  function cr(l, t, a) {
    var e = Object.getOwnPropertyDescriptor(
      l.constructor.prototype,
      t
    );
    if (!l.hasOwnProperty(t) && typeof e < "u" && typeof e.get == "function" && typeof e.set == "function") {
      var u = e.get, n = e.set;
      return Object.defineProperty(l, t, {
        configurable: !0,
        get: function() {
          return u.call(this);
        },
        set: function(i) {
          a = "" + i, n.call(this, i);
        }
      }), Object.defineProperty(l, t, {
        enumerable: e.enumerable
      }), {
        getValue: function() {
          return a;
        },
        setValue: function(i) {
          a = "" + i;
        },
        stopTracking: function() {
          l._valueTracker = null, delete l[t];
        }
      };
    }
  }
  function mi(l) {
    if (!l._valueTracker) {
      var t = Vf(l) ? "checked" : "value";
      l._valueTracker = cr(
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
    var a = t.getValue(), e = "";
    return l && (e = Vf(l) ? l.checked ? "true" : "false" : l.value), l = e, l !== a ? (t.setValue(l), !0) : !1;
  }
  function Qu(l) {
    if (l = l || (typeof document < "u" ? document : void 0), typeof l > "u") return null;
    try {
      return l.activeElement || l.body;
    } catch {
      return l.body;
    }
  }
  var fr = /[\n"\\]/g;
  function rt(l) {
    return l.replace(
      fr,
      function(t) {
        return "\\" + t.charCodeAt(0).toString(16) + " ";
      }
    );
  }
  function ri(l, t, a, e, u, n, i, c) {
    l.name = "", i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" ? l.type = i : l.removeAttribute("type"), t != null ? i === "number" ? (t === 0 && l.value === "" || l.value != t) && (l.value = "" + mt(t)) : l.value !== "" + mt(t) && (l.value = "" + mt(t)) : i !== "submit" && i !== "reset" || l.removeAttribute("value"), t != null ? hi(l, i, mt(t)) : a != null ? hi(l, i, mt(a)) : e != null && l.removeAttribute("value"), u == null && n != null && (l.defaultChecked = !!n), u != null && (l.checked = u && typeof u != "function" && typeof u != "symbol"), c != null && typeof c != "function" && typeof c != "symbol" && typeof c != "boolean" ? l.name = "" + mt(c) : l.removeAttribute("name");
  }
  function Jf(l, t, a, e, u, n, i, c) {
    if (n != null && typeof n != "function" && typeof n != "symbol" && typeof n != "boolean" && (l.type = n), t != null || a != null) {
      if (!(n !== "submit" && n !== "reset" || t != null)) {
        mi(l);
        return;
      }
      a = a != null ? "" + mt(a) : "", t = t != null ? "" + mt(t) : a, c || t === l.value || (l.value = t), l.defaultValue = t;
    }
    e = e ?? u, e = typeof e != "function" && typeof e != "symbol" && !!e, l.checked = c ? l.checked : !!e, l.defaultChecked = !!e, i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" && (l.name = i), mi(l);
  }
  function hi(l, t, a) {
    t === "number" && Qu(l.ownerDocument) === l || l.defaultValue === "" + a || (l.defaultValue = "" + a);
  }
  function te(l, t, a, e) {
    if (l = l.options, t) {
      t = {};
      for (var u = 0; u < a.length; u++)
        t["$" + a[u]] = !0;
      for (a = 0; a < l.length; a++)
        u = t.hasOwnProperty("$" + l[a].value), l[a].selected !== u && (l[a].selected = u), u && e && (l[a].defaultSelected = !0);
    } else {
      for (a = "" + mt(a), t = null, u = 0; u < l.length; u++) {
        if (l[u].value === a) {
          l[u].selected = !0, e && (l[u].defaultSelected = !0);
          return;
        }
        t !== null || l[u].disabled || (t = l[u]);
      }
      t !== null && (t.selected = !0);
    }
  }
  function wf(l, t, a) {
    if (t != null && (t = "" + mt(t), t !== l.value && (l.value = t), a == null)) {
      l.defaultValue !== t && (l.defaultValue = t);
      return;
    }
    l.defaultValue = a != null ? "" + mt(a) : "";
  }
  function $f(l, t, a, e) {
    if (t == null) {
      if (e != null) {
        if (a != null) throw Error(o(92));
        if (At(e)) {
          if (1 < e.length) throw Error(o(93));
          e = e[0];
        }
        a = e;
      }
      a == null && (a = ""), t = a;
    }
    a = mt(t), l.defaultValue = a, e = l.textContent, e === a && e !== "" && e !== null && (l.value = e), mi(l);
  }
  function ae(l, t) {
    if (t) {
      var a = l.firstChild;
      if (a && a === l.lastChild && a.nodeType === 3) {
        a.nodeValue = t;
        return;
      }
    }
    l.textContent = t;
  }
  var sr = new Set(
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
      " "
    )
  );
  function Wf(l, t, a) {
    var e = t.indexOf("--") === 0;
    a == null || typeof a == "boolean" || a === "" ? e ? l.setProperty(t, "") : t === "float" ? l.cssFloat = "" : l[t] = "" : e ? l.setProperty(t, a) : typeof a != "number" || a === 0 || sr.has(t) ? t === "float" ? l.cssFloat = a : l[t] = ("" + a).trim() : l[t] = a + "px";
  }
  function kf(l, t, a) {
    if (t != null && typeof t != "object")
      throw Error(o(62));
    if (l = l.style, a != null) {
      for (var e in a)
        !a.hasOwnProperty(e) || t != null && t.hasOwnProperty(e) || (e.indexOf("--") === 0 ? l.setProperty(e, "") : e === "float" ? l.cssFloat = "" : l[e] = "");
      for (var u in t)
        e = t[u], t.hasOwnProperty(u) && a[u] !== e && Wf(l, u, e);
    } else
      for (var n in t)
        t.hasOwnProperty(n) && Wf(l, n, t[n]);
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
  var dr = /* @__PURE__ */ new Map([
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
  ]), or = /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function Xu(l) {
    return or.test("" + l) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : l;
  }
  function Ht() {
  }
  var yi = null;
  function gi(l) {
    return l = l.target || l.srcElement || window, l.correspondingUseElement && (l = l.correspondingUseElement), l.nodeType === 3 ? l.parentNode : l;
  }
  var ee = null, ue = null;
  function Ff(l) {
    var t = Ia(l);
    if (t && (l = t.stateNode)) {
      var a = l[Kl] || null;
      l: switch (l = t.stateNode, t.type) {
        case "input":
          if (ri(
            l,
            a.value,
            a.defaultValue,
            a.defaultValue,
            a.checked,
            a.defaultChecked,
            a.type,
            a.name
          ), t = a.name, a.type === "radio" && t != null) {
            for (a = l; a.parentNode; ) a = a.parentNode;
            for (a = a.querySelectorAll(
              'input[name="' + rt(
                "" + t
              ) + '"][type="radio"]'
            ), t = 0; t < a.length; t++) {
              var e = a[t];
              if (e !== l && e.form === l.form) {
                var u = e[Kl] || null;
                if (!u) throw Error(o(90));
                ri(
                  e,
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
            for (t = 0; t < a.length; t++)
              e = a[t], e.form === l.form && Kf(e);
          }
          break l;
        case "textarea":
          wf(l, a.value, a.defaultValue);
          break l;
        case "select":
          t = a.value, t != null && te(l, !!a.multiple, t, !1);
      }
    }
  }
  var Si = !1;
  function If(l, t, a) {
    if (Si) return l(t, a);
    Si = !0;
    try {
      var e = l(t);
      return e;
    } finally {
      if (Si = !1, (ee !== null || ue !== null) && (Nn(), ee && (t = ee, l = ue, ue = ee = null, Ff(t), l)))
        for (t = 0; t < l.length; t++) Ff(l[t]);
    }
  }
  function Xe(l, t) {
    var a = l.stateNode;
    if (a === null) return null;
    var e = a[Kl] || null;
    if (e === null) return null;
    a = e[t];
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
        (e = !e.disabled) || (l = l.type, e = !(l === "button" || l === "input" || l === "select" || l === "textarea")), l = !e;
        break l;
      default:
        l = !1;
    }
    if (l) return null;
    if (a && typeof a != "function")
      throw Error(
        o(231, t, typeof a)
      );
    return a;
  }
  var qt = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), bi = !1;
  if (qt)
    try {
      var Le = {};
      Object.defineProperty(Le, "passive", {
        get: function() {
          bi = !0;
        }
      }), window.addEventListener("test", Le, Le), window.removeEventListener("test", Le, Le);
    } catch {
      bi = !1;
    }
  var ea = null, pi = null, Lu = null;
  function Pf() {
    if (Lu) return Lu;
    var l, t = pi, a = t.length, e, u = "value" in ea ? ea.value : ea.textContent, n = u.length;
    for (l = 0; l < a && t[l] === u[l]; l++) ;
    var i = a - l;
    for (e = 1; e <= i && t[a - e] === u[n - e]; e++) ;
    return Lu = u.slice(l, 1 < e ? 1 - e : void 0);
  }
  function Zu(l) {
    var t = l.keyCode;
    return "charCode" in l ? (l = l.charCode, l === 0 && t === 13 && (l = 13)) : l = t, l === 10 && (l = 13), 32 <= l || l === 13 ? l : 0;
  }
  function Vu() {
    return !0;
  }
  function ls() {
    return !1;
  }
  function Jl(l) {
    function t(a, e, u, n, i) {
      this._reactName = a, this._targetInst = u, this.type = e, this.nativeEvent = n, this.target = i, this.currentTarget = null;
      for (var c in l)
        l.hasOwnProperty(c) && (a = l[c], this[c] = a ? a(n) : n[c]);
      return this.isDefaultPrevented = (n.defaultPrevented != null ? n.defaultPrevented : n.returnValue === !1) ? Vu : ls, this.isPropagationStopped = ls, this;
    }
    return A(t.prototype, {
      preventDefault: function() {
        this.defaultPrevented = !0;
        var a = this.nativeEvent;
        a && (a.preventDefault ? a.preventDefault() : typeof a.returnValue != "unknown" && (a.returnValue = !1), this.isDefaultPrevented = Vu);
      },
      stopPropagation: function() {
        var a = this.nativeEvent;
        a && (a.stopPropagation ? a.stopPropagation() : typeof a.cancelBubble != "unknown" && (a.cancelBubble = !0), this.isPropagationStopped = Vu);
      },
      persist: function() {
      },
      isPersistent: Vu
    }), t;
  }
  var Ma = {
    eventPhase: 0,
    bubbles: 0,
    cancelable: 0,
    timeStamp: function(l) {
      return l.timeStamp || Date.now();
    },
    defaultPrevented: 0,
    isTrusted: 0
  }, Ku = Jl(Ma), Ze = A({}, Ma, { view: 0, detail: 0 }), mr = Jl(Ze), zi, Ai, Ve, Ju = A({}, Ze, {
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
      return "movementX" in l ? l.movementX : (l !== Ve && (Ve && l.type === "mousemove" ? (zi = l.screenX - Ve.screenX, Ai = l.screenY - Ve.screenY) : Ai = zi = 0, Ve = l), zi);
    },
    movementY: function(l) {
      return "movementY" in l ? l.movementY : Ai;
    }
  }), ts = Jl(Ju), rr = A({}, Ju, { dataTransfer: 0 }), hr = Jl(rr), vr = A({}, Ze, { relatedTarget: 0 }), Ti = Jl(vr), yr = A({}, Ma, {
    animationName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), gr = Jl(yr), Sr = A({}, Ma, {
    clipboardData: function(l) {
      return "clipboardData" in l ? l.clipboardData : window.clipboardData;
    }
  }), br = Jl(Sr), pr = A({}, Ma, { data: 0 }), as = Jl(pr), zr = {
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
  }, Ar = {
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
  }, Tr = {
    Alt: "altKey",
    Control: "ctrlKey",
    Meta: "metaKey",
    Shift: "shiftKey"
  };
  function jr(l) {
    var t = this.nativeEvent;
    return t.getModifierState ? t.getModifierState(l) : (l = Tr[l]) ? !!t[l] : !1;
  }
  function ji() {
    return jr;
  }
  var Er = A({}, Ze, {
    key: function(l) {
      if (l.key) {
        var t = zr[l.key] || l.key;
        if (t !== "Unidentified") return t;
      }
      return l.type === "keypress" ? (l = Zu(l), l === 13 ? "Enter" : String.fromCharCode(l)) : l.type === "keydown" || l.type === "keyup" ? Ar[l.keyCode] || "Unidentified" : "";
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
  }), xr = Jl(Er), _r = A({}, Ju, {
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
  }), es = Jl(_r), Or = A({}, Ze, {
    touches: 0,
    targetTouches: 0,
    changedTouches: 0,
    altKey: 0,
    metaKey: 0,
    ctrlKey: 0,
    shiftKey: 0,
    getModifierState: ji
  }), Nr = Jl(Or), Mr = A({}, Ma, {
    propertyName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Dr = Jl(Mr), Ur = A({}, Ju, {
    deltaX: function(l) {
      return "deltaX" in l ? l.deltaX : "wheelDeltaX" in l ? -l.wheelDeltaX : 0;
    },
    deltaY: function(l) {
      return "deltaY" in l ? l.deltaY : "wheelDeltaY" in l ? -l.wheelDeltaY : "wheelDelta" in l ? -l.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), Rr = Jl(Ur), Cr = A({}, Ma, {
    newState: 0,
    oldState: 0
  }), Hr = Jl(Cr), qr = [9, 13, 27, 32], Ei = qt && "CompositionEvent" in window, Ke = null;
  qt && "documentMode" in document && (Ke = document.documentMode);
  var Br = qt && "TextEvent" in window && !Ke, us = qt && (!Ei || Ke && 8 < Ke && 11 >= Ke), ns = " ", is = !1;
  function cs(l, t) {
    switch (l) {
      case "keyup":
        return qr.indexOf(t.keyCode) !== -1;
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
  var ne = !1;
  function Yr(l, t) {
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
  function Gr(l, t) {
    if (ne)
      return l === "compositionend" || !Ei && cs(l, t) ? (l = Pf(), Lu = pi = ea = null, ne = !1, l) : null;
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
  var Qr = {
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
    return t === "input" ? !!Qr[l.type] : t === "textarea";
  }
  function ds(l, t, a, e) {
    ee ? ue ? ue.push(e) : ue = [e] : ee = e, t = qn(t, "onChange"), 0 < t.length && (a = new Ku(
      "onChange",
      "change",
      null,
      a,
      e
    ), l.push({ event: a, listeners: t }));
  }
  var Je = null, we = null;
  function Xr(l) {
    wo(l, 0);
  }
  function wu(l) {
    var t = Qe(l);
    if (Kf(t)) return l;
  }
  function os(l, t) {
    if (l === "change") return t;
  }
  var ms = !1;
  if (qt) {
    var xi;
    if (qt) {
      var _i = "oninput" in document;
      if (!_i) {
        var rs = document.createElement("div");
        rs.setAttribute("oninput", "return;"), _i = typeof rs.oninput == "function";
      }
      xi = _i;
    } else xi = !1;
    ms = xi && (!document.documentMode || 9 < document.documentMode);
  }
  function hs() {
    Je && (Je.detachEvent("onpropertychange", vs), we = Je = null);
  }
  function vs(l) {
    if (l.propertyName === "value" && wu(we)) {
      var t = [];
      ds(
        t,
        we,
        l,
        gi(l)
      ), If(Xr, t);
    }
  }
  function Lr(l, t, a) {
    l === "focusin" ? (hs(), Je = t, we = a, Je.attachEvent("onpropertychange", vs)) : l === "focusout" && hs();
  }
  function Zr(l) {
    if (l === "selectionchange" || l === "keyup" || l === "keydown")
      return wu(we);
  }
  function Vr(l, t) {
    if (l === "click") return wu(t);
  }
  function Kr(l, t) {
    if (l === "input" || l === "change")
      return wu(t);
  }
  function Jr(l, t) {
    return l === t && (l !== 0 || 1 / l === 1 / t) || l !== l && t !== t;
  }
  var at = typeof Object.is == "function" ? Object.is : Jr;
  function $e(l, t) {
    if (at(l, t)) return !0;
    if (typeof l != "object" || l === null || typeof t != "object" || t === null)
      return !1;
    var a = Object.keys(l), e = Object.keys(t);
    if (a.length !== e.length) return !1;
    for (e = 0; e < a.length; e++) {
      var u = a[e];
      if (!ui.call(t, u) || !at(l[u], t[u]))
        return !1;
    }
    return !0;
  }
  function ys(l) {
    for (; l && l.firstChild; ) l = l.firstChild;
    return l;
  }
  function gs(l, t) {
    var a = ys(l);
    l = 0;
    for (var e; a; ) {
      if (a.nodeType === 3) {
        if (e = l + a.textContent.length, l <= t && e >= t)
          return { node: a, offset: t - l };
        l = e;
      }
      l: {
        for (; a; ) {
          if (a.nextSibling) {
            a = a.nextSibling;
            break l;
          }
          a = a.parentNode;
        }
        a = void 0;
      }
      a = ys(a);
    }
  }
  function Ss(l, t) {
    return l && t ? l === t ? !0 : l && l.nodeType === 3 ? !1 : t && t.nodeType === 3 ? Ss(l, t.parentNode) : "contains" in l ? l.contains(t) : l.compareDocumentPosition ? !!(l.compareDocumentPosition(t) & 16) : !1 : !1;
  }
  function bs(l) {
    l = l != null && l.ownerDocument != null && l.ownerDocument.defaultView != null ? l.ownerDocument.defaultView : window;
    for (var t = Qu(l.document); t instanceof l.HTMLIFrameElement; ) {
      try {
        var a = typeof t.contentWindow.location.href == "string";
      } catch {
        a = !1;
      }
      if (a) l = t.contentWindow;
      else break;
      t = Qu(l.document);
    }
    return t;
  }
  function Oi(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t && (t === "input" && (l.type === "text" || l.type === "search" || l.type === "tel" || l.type === "url" || l.type === "password") || t === "textarea" || l.contentEditable === "true");
  }
  var wr = qt && "documentMode" in document && 11 >= document.documentMode, ie = null, Ni = null, We = null, Mi = !1;
  function ps(l, t, a) {
    var e = a.window === a ? a.document : a.nodeType === 9 ? a : a.ownerDocument;
    Mi || ie == null || ie !== Qu(e) || (e = ie, "selectionStart" in e && Oi(e) ? e = { start: e.selectionStart, end: e.selectionEnd } : (e = (e.ownerDocument && e.ownerDocument.defaultView || window).getSelection(), e = {
      anchorNode: e.anchorNode,
      anchorOffset: e.anchorOffset,
      focusNode: e.focusNode,
      focusOffset: e.focusOffset
    }), We && $e(We, e) || (We = e, e = qn(Ni, "onSelect"), 0 < e.length && (t = new Ku(
      "onSelect",
      "select",
      null,
      t,
      a
    ), l.push({ event: t, listeners: e }), t.target = ie)));
  }
  function Da(l, t) {
    var a = {};
    return a[l.toLowerCase()] = t.toLowerCase(), a["Webkit" + l] = "webkit" + t, a["Moz" + l] = "moz" + t, a;
  }
  var ce = {
    animationend: Da("Animation", "AnimationEnd"),
    animationiteration: Da("Animation", "AnimationIteration"),
    animationstart: Da("Animation", "AnimationStart"),
    transitionrun: Da("Transition", "TransitionRun"),
    transitionstart: Da("Transition", "TransitionStart"),
    transitioncancel: Da("Transition", "TransitionCancel"),
    transitionend: Da("Transition", "TransitionEnd")
  }, Di = {}, zs = {};
  qt && (zs = document.createElement("div").style, "AnimationEvent" in window || (delete ce.animationend.animation, delete ce.animationiteration.animation, delete ce.animationstart.animation), "TransitionEvent" in window || delete ce.transitionend.transition);
  function Ua(l) {
    if (Di[l]) return Di[l];
    if (!ce[l]) return l;
    var t = ce[l], a;
    for (a in t)
      if (t.hasOwnProperty(a) && a in zs)
        return Di[l] = t[a];
    return l;
  }
  var As = Ua("animationend"), Ts = Ua("animationiteration"), js = Ua("animationstart"), $r = Ua("transitionrun"), Wr = Ua("transitionstart"), kr = Ua("transitioncancel"), Es = Ua("transitionend"), xs = /* @__PURE__ */ new Map(), Ui = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
    " "
  );
  Ui.push("scrollEnd");
  function Tt(l, t) {
    xs.set(l, t), Na(t, [l]);
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
  }, ht = [], fe = 0, Ri = 0;
  function Wu() {
    for (var l = fe, t = Ri = fe = 0; t < l; ) {
      var a = ht[t];
      ht[t++] = null;
      var e = ht[t];
      ht[t++] = null;
      var u = ht[t];
      ht[t++] = null;
      var n = ht[t];
      if (ht[t++] = null, e !== null && u !== null) {
        var i = e.pending;
        i === null ? u.next = u : (u.next = i.next, i.next = u), e.pending = u;
      }
      n !== 0 && _s(a, u, n);
    }
  }
  function ku(l, t, a, e) {
    ht[fe++] = l, ht[fe++] = t, ht[fe++] = a, ht[fe++] = e, Ri |= e, l.lanes |= e, l = l.alternate, l !== null && (l.lanes |= e);
  }
  function Ci(l, t, a, e) {
    return ku(l, t, a, e), Fu(l);
  }
  function Ra(l, t) {
    return ku(l, null, null, t), Fu(l);
  }
  function _s(l, t, a) {
    l.lanes |= a;
    var e = l.alternate;
    e !== null && (e.lanes |= a);
    for (var u = !1, n = l.return; n !== null; )
      n.childLanes |= a, e = n.alternate, e !== null && (e.childLanes |= a), n.tag === 22 && (l = n.stateNode, l === null || l._visibility & 1 || (u = !0)), l = n, n = n.return;
    return l.tag === 3 ? (n = l.stateNode, u && t !== null && (u = 31 - tt(a), l = n.hiddenUpdates, e = l[u], e === null ? l[u] = [t] : e.push(t), t.lane = a | 536870912), n) : null;
  }
  function Fu(l) {
    if (50 < gu)
      throw gu = 0, Zc = null, Error(o(185));
    for (var t = l.return; t !== null; )
      l = t, t = l.return;
    return l.tag === 3 ? l.stateNode : null;
  }
  var se = {};
  function Fr(l, t, a, e) {
    this.tag = l, this.key = a, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = e, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function et(l, t, a, e) {
    return new Fr(l, t, a, e);
  }
  function Hi(l) {
    return l = l.prototype, !(!l || !l.isReactComponent);
  }
  function Bt(l, t) {
    var a = l.alternate;
    return a === null ? (a = et(
      l.tag,
      t,
      l.key,
      l.mode
    ), a.elementType = l.elementType, a.type = l.type, a.stateNode = l.stateNode, a.alternate = l, l.alternate = a) : (a.pendingProps = t, a.type = l.type, a.flags = 0, a.subtreeFlags = 0, a.deletions = null), a.flags = l.flags & 65011712, a.childLanes = l.childLanes, a.lanes = l.lanes, a.child = l.child, a.memoizedProps = l.memoizedProps, a.memoizedState = l.memoizedState, a.updateQueue = l.updateQueue, t = l.dependencies, a.dependencies = t === null ? null : { lanes: t.lanes, firstContext: t.firstContext }, a.sibling = l.sibling, a.index = l.index, a.ref = l.ref, a.refCleanup = l.refCleanup, a;
  }
  function Os(l, t) {
    l.flags &= 65011714;
    var a = l.alternate;
    return a === null ? (l.childLanes = 0, l.lanes = t, l.child = null, l.subtreeFlags = 0, l.memoizedProps = null, l.memoizedState = null, l.updateQueue = null, l.dependencies = null, l.stateNode = null) : (l.childLanes = a.childLanes, l.lanes = a.lanes, l.child = a.child, l.subtreeFlags = 0, l.deletions = null, l.memoizedProps = a.memoizedProps, l.memoizedState = a.memoizedState, l.updateQueue = a.updateQueue, l.type = a.type, t = a.dependencies, l.dependencies = t === null ? null : {
      lanes: t.lanes,
      firstContext: t.firstContext
    }), l;
  }
  function Iu(l, t, a, e, u, n) {
    var i = 0;
    if (e = l, typeof l == "function") Hi(l) && (i = 1);
    else if (typeof l == "string")
      i = av(
        l,
        a,
        q.current
      ) ? 26 : l === "html" || l === "head" || l === "body" ? 27 : 5;
    else
      l: switch (l) {
        case _t:
          return l = et(31, a, t, u), l.elementType = _t, l.lanes = n, l;
        case ul:
          return Ca(a.children, u, n, t);
        case tl:
          i = 8, u |= 24;
          break;
        case Il:
          return l = et(12, a, t, u | 2), l.elementType = Il, l.lanes = n, l;
        case xt:
          return l = et(13, a, t, u), l.elementType = xt, l.lanes = n, l;
        case Ll:
          return l = et(19, a, t, u), l.elementType = Ll, l.lanes = n, l;
        default:
          if (typeof l == "object" && l !== null)
            switch (l.$$typeof) {
              case Bl:
                i = 10;
                break l;
              case la:
                i = 9;
                break l;
              case ot:
                i = 11;
                break l;
              case I:
                i = 14;
                break l;
              case Zl:
                i = 16, e = null;
                break l;
            }
          i = 29, a = Error(
            o(130, l === null ? "null" : typeof l, "")
          ), e = null;
      }
    return t = et(i, a, t, u), t.elementType = l, t.type = e, t.lanes = n, t;
  }
  function Ca(l, t, a, e) {
    return l = et(7, l, e, t), l.lanes = a, l;
  }
  function qi(l, t, a) {
    return l = et(6, l, null, t), l.lanes = a, l;
  }
  function Ns(l) {
    var t = et(18, null, null, 0);
    return t.stateNode = l, t;
  }
  function Bi(l, t, a) {
    return t = et(
      4,
      l.children !== null ? l.children : [],
      l.key,
      t
    ), t.lanes = a, t.stateNode = {
      containerInfo: l.containerInfo,
      pendingChildren: null,
      implementation: l.implementation
    }, t;
  }
  var Ms = /* @__PURE__ */ new WeakMap();
  function vt(l, t) {
    if (typeof l == "object" && l !== null) {
      var a = Ms.get(l);
      return a !== void 0 ? a : (t = {
        value: l,
        source: t,
        stack: Nf(t)
      }, Ms.set(l, t), t);
    }
    return {
      value: l,
      source: t,
      stack: Nf(t)
    };
  }
  var de = [], oe = 0, Pu = null, ke = 0, yt = [], gt = 0, ua = null, Nt = 1, Mt = "";
  function Yt(l, t) {
    de[oe++] = ke, de[oe++] = Pu, Pu = l, ke = t;
  }
  function Ds(l, t, a) {
    yt[gt++] = Nt, yt[gt++] = Mt, yt[gt++] = ua, ua = l;
    var e = Nt;
    l = Mt;
    var u = 32 - tt(e) - 1;
    e &= ~(1 << u), a += 1;
    var n = 32 - tt(t) + u;
    if (30 < n) {
      var i = u - u % 5;
      n = (e & (1 << i) - 1).toString(32), e >>= i, u -= i, Nt = 1 << 32 - tt(t) + u | a << u | e, Mt = n + l;
    } else
      Nt = 1 << n | a << u | e, Mt = l;
  }
  function Yi(l) {
    l.return !== null && (Yt(l, 1), Ds(l, 1, 0));
  }
  function Gi(l) {
    for (; l === Pu; )
      Pu = de[--oe], de[oe] = null, ke = de[--oe], de[oe] = null;
    for (; l === ua; )
      ua = yt[--gt], yt[gt] = null, Mt = yt[--gt], yt[gt] = null, Nt = yt[--gt], yt[gt] = null;
  }
  function Us(l, t) {
    yt[gt++] = Nt, yt[gt++] = Mt, yt[gt++] = ua, Nt = t.id, Mt = t.overflow, ua = l;
  }
  var Rl = null, vl = null, P = !1, na = null, St = !1, Qi = Error(o(519));
  function ia(l) {
    var t = Error(
      o(
        418,
        1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML",
        ""
      )
    );
    throw Fe(vt(t, l)), Qi;
  }
  function Rs(l) {
    var t = l.stateNode, a = l.type, e = l.memoizedProps;
    switch (t[Ul] = l, t[Kl] = e, a) {
      case "dialog":
        W("cancel", t), W("close", t);
        break;
      case "iframe":
      case "object":
      case "embed":
        W("load", t);
        break;
      case "video":
      case "audio":
        for (a = 0; a < bu.length; a++)
          W(bu[a], t);
        break;
      case "source":
        W("error", t);
        break;
      case "img":
      case "image":
      case "link":
        W("error", t), W("load", t);
        break;
      case "details":
        W("toggle", t);
        break;
      case "input":
        W("invalid", t), Jf(
          t,
          e.value,
          e.defaultValue,
          e.checked,
          e.defaultChecked,
          e.type,
          e.name,
          !0
        );
        break;
      case "select":
        W("invalid", t);
        break;
      case "textarea":
        W("invalid", t), $f(t, e.value, e.defaultValue, e.children);
    }
    a = e.children, typeof a != "string" && typeof a != "number" && typeof a != "bigint" || t.textContent === "" + a || e.suppressHydrationWarning === !0 || Fo(t.textContent, a) ? (e.popover != null && (W("beforetoggle", t), W("toggle", t)), e.onScroll != null && W("scroll", t), e.onScrollEnd != null && W("scrollend", t), e.onClick != null && (t.onclick = Ht), t = !0) : t = !1, t || ia(l, !0);
  }
  function Cs(l) {
    for (Rl = l.return; Rl; )
      switch (Rl.tag) {
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
          Rl = Rl.return;
      }
  }
  function me(l) {
    if (l !== Rl) return !1;
    if (!P) return Cs(l), P = !0, !1;
    var t = l.tag, a;
    if ((a = t !== 3 && t !== 27) && ((a = t === 5) && (a = l.type, a = !(a !== "form" && a !== "button") || uf(l.type, l.memoizedProps)), a = !a), a && vl && ia(l), Cs(l), t === 13) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(317));
      vl = im(l);
    } else if (t === 31) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(317));
      vl = im(l);
    } else
      t === 27 ? (t = vl, pa(l.type) ? (l = df, df = null, vl = l) : vl = t) : vl = Rl ? pt(l.stateNode.nextSibling) : null;
    return !0;
  }
  function Ha() {
    vl = Rl = null, P = !1;
  }
  function Xi() {
    var l = na;
    return l !== null && (kl === null ? kl = l : kl.push.apply(
      kl,
      l
    ), na = null), l;
  }
  function Fe(l) {
    na === null ? na = [l] : na.push(l);
  }
  var Li = m(null), qa = null, Gt = null;
  function ca(l, t, a) {
    U(Li, t._currentValue), t._currentValue = a;
  }
  function Qt(l) {
    l._currentValue = Li.current, E(Li);
  }
  function Zi(l, t, a) {
    for (; l !== null; ) {
      var e = l.alternate;
      if ((l.childLanes & t) !== t ? (l.childLanes |= t, e !== null && (e.childLanes |= t)) : e !== null && (e.childLanes & t) !== t && (e.childLanes |= t), l === a) break;
      l = l.return;
    }
  }
  function Vi(l, t, a, e) {
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
              n.lanes |= a, c = n.alternate, c !== null && (c.lanes |= a), Zi(
                n.return,
                a,
                l
              ), e || (i = null);
              break l;
            }
          n = c.next;
        }
      } else if (u.tag === 18) {
        if (i = u.return, i === null) throw Error(o(341));
        i.lanes |= a, n = i.alternate, n !== null && (n.lanes |= a), Zi(i, a, l), i = null;
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
  function re(l, t, a, e) {
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
          var c = u.type;
          at(u.pendingProps.value, i.value) || (l !== null ? l.push(c) : l = [c]);
        }
      } else if (u === il.current) {
        if (i = u.alternate, i === null) throw Error(o(387));
        i.memoizedState.memoizedState !== u.memoizedState.memoizedState && (l !== null ? l.push(ju) : l = [ju]);
      }
      u = u.return;
    }
    l !== null && Vi(
      t,
      l,
      a,
      e
    ), t.flags |= 262144;
  }
  function ln(l) {
    for (l = l.firstContext; l !== null; ) {
      if (!at(
        l.context._currentValue,
        l.memoizedValue
      ))
        return !0;
      l = l.next;
    }
    return !1;
  }
  function Ba(l) {
    qa = l, Gt = null, l = l.dependencies, l !== null && (l.firstContext = null);
  }
  function Cl(l) {
    return Hs(qa, l);
  }
  function tn(l, t) {
    return qa === null && Ba(l), Hs(l, t);
  }
  function Hs(l, t) {
    var a = t._currentValue;
    if (t = { context: t, memoizedValue: a, next: null }, Gt === null) {
      if (l === null) throw Error(o(308));
      Gt = t, l.dependencies = { lanes: 0, firstContext: t }, l.flags |= 524288;
    } else Gt = Gt.next = t;
    return a;
  }
  var Ir = typeof AbortController < "u" ? AbortController : function() {
    var l = [], t = this.signal = {
      aborted: !1,
      addEventListener: function(a, e) {
        l.push(e);
      }
    };
    this.abort = function() {
      t.aborted = !0, l.forEach(function(a) {
        return a();
      });
    };
  }, Pr = r.unstable_scheduleCallback, lh = r.unstable_NormalPriority, El = {
    $$typeof: Bl,
    Consumer: null,
    Provider: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0
  };
  function Ki() {
    return {
      controller: new Ir(),
      data: /* @__PURE__ */ new Map(),
      refCount: 0
    };
  }
  function Ie(l) {
    l.refCount--, l.refCount === 0 && Pr(lh, function() {
      l.controller.abort();
    });
  }
  var Pe = null, Ji = 0, he = 0, ve = null;
  function th(l, t) {
    if (Pe === null) {
      var a = Pe = [];
      Ji = 0, he = Wc(), ve = {
        status: "pending",
        value: void 0,
        then: function(e) {
          a.push(e);
        }
      };
    }
    return Ji++, t.then(qs, qs), t;
  }
  function qs() {
    if (--Ji === 0 && Pe !== null) {
      ve !== null && (ve.status = "fulfilled");
      var l = Pe;
      Pe = null, he = 0, ve = null;
      for (var t = 0; t < l.length; t++) (0, l[t])();
    }
  }
  function ah(l, t) {
    var a = [], e = {
      status: "pending",
      value: null,
      reason: null,
      then: function(u) {
        a.push(u);
      }
    };
    return l.then(
      function() {
        e.status = "fulfilled", e.value = t;
        for (var u = 0; u < a.length; u++) (0, a[u])(t);
      },
      function(u) {
        for (e.status = "rejected", e.reason = u, u = 0; u < a.length; u++)
          (0, a[u])(void 0);
      }
    ), e;
  }
  var Bs = z.S;
  z.S = function(l, t) {
    zo = Pl(), typeof t == "object" && t !== null && typeof t.then == "function" && th(l, t), Bs !== null && Bs(l, t);
  };
  var Ya = m(null);
  function wi() {
    var l = Ya.current;
    return l !== null ? l : hl.pooledCache;
  }
  function an(l, t) {
    t === null ? U(Ya, Ya.current) : U(Ya, t.pool);
  }
  function Ys() {
    var l = wi();
    return l === null ? null : { parent: El._currentValue, pool: l };
  }
  var ye = Error(o(460)), $i = Error(o(474)), en = Error(o(542)), un = { then: function() {
  } };
  function Gs(l) {
    return l = l.status, l === "fulfilled" || l === "rejected";
  }
  function Qs(l, t, a) {
    switch (a = l[a], a === void 0 ? l.push(t) : a !== t && (t.then(Ht, Ht), t = a), t.status) {
      case "fulfilled":
        return t.value;
      case "rejected":
        throw l = t.reason, Ls(l), l;
      default:
        if (typeof t.status == "string") t.then(Ht, Ht);
        else {
          if (l = hl, l !== null && 100 < l.shellSuspendCounter)
            throw Error(o(482));
          l = t, l.status = "pending", l.then(
            function(e) {
              if (t.status === "pending") {
                var u = t;
                u.status = "fulfilled", u.value = e;
              }
            },
            function(e) {
              if (t.status === "pending") {
                var u = t;
                u.status = "rejected", u.reason = e;
              }
            }
          );
        }
        switch (t.status) {
          case "fulfilled":
            return t.value;
          case "rejected":
            throw l = t.reason, Ls(l), l;
        }
        throw Qa = t, ye;
    }
  }
  function Ga(l) {
    try {
      var t = l._init;
      return t(l._payload);
    } catch (a) {
      throw a !== null && typeof a == "object" && typeof a.then == "function" ? (Qa = a, ye) : a;
    }
  }
  var Qa = null;
  function Xs() {
    if (Qa === null) throw Error(o(459));
    var l = Qa;
    return Qa = null, l;
  }
  function Ls(l) {
    if (l === ye || l === en)
      throw Error(o(483));
  }
  var ge = null, lu = 0;
  function nn(l) {
    var t = lu;
    return lu += 1, ge === null && (ge = []), Qs(ge, l, t);
  }
  function tu(l, t) {
    t = t.props.ref, l.ref = t !== void 0 ? t : null;
  }
  function cn(l, t) {
    throw t.$$typeof === _ ? Error(o(525)) : (l = Object.prototype.toString.call(t), Error(
      o(
        31,
        l === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : l
      )
    ));
  }
  function Zs(l) {
    function t(h, d) {
      if (l) {
        var v = h.deletions;
        v === null ? (h.deletions = [d], h.flags |= 16) : v.push(d);
      }
    }
    function a(h, d) {
      if (!l) return null;
      for (; d !== null; )
        t(h, d), d = d.sibling;
      return null;
    }
    function e(h) {
      for (var d = /* @__PURE__ */ new Map(); h !== null; )
        h.key !== null ? d.set(h.key, h) : d.set(h.index, h), h = h.sibling;
      return d;
    }
    function u(h, d) {
      return h = Bt(h, d), h.index = 0, h.sibling = null, h;
    }
    function n(h, d, v) {
      return h.index = v, l ? (v = h.alternate, v !== null ? (v = v.index, v < d ? (h.flags |= 67108866, d) : v) : (h.flags |= 67108866, d)) : (h.flags |= 1048576, d);
    }
    function i(h) {
      return l && h.alternate === null && (h.flags |= 67108866), h;
    }
    function c(h, d, v, T) {
      return d === null || d.tag !== 6 ? (d = qi(v, h.mode, T), d.return = h, d) : (d = u(d, v), d.return = h, d);
    }
    function s(h, d, v, T) {
      var Y = v.type;
      return Y === ul ? p(
        h,
        d,
        v.props.children,
        T,
        v.key
      ) : d !== null && (d.elementType === Y || typeof Y == "object" && Y !== null && Y.$$typeof === Zl && Ga(Y) === d.type) ? (d = u(d, v.props), tu(d, v), d.return = h, d) : (d = Iu(
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
    function p(h, d, v, T, Y) {
      return d === null || d.tag !== 7 ? (d = Ca(
        v,
        h.mode,
        T,
        Y
      ), d.return = h, d) : (d = u(d, v), d.return = h, d);
    }
    function j(h, d, v) {
      if (typeof d == "string" && d !== "" || typeof d == "number" || typeof d == "bigint")
        return d = qi(
          "" + d,
          h.mode,
          v
        ), d.return = h, d;
      if (typeof d == "object" && d !== null) {
        switch (d.$$typeof) {
          case ll:
            return v = Iu(
              d.type,
              d.key,
              d.props,
              null,
              h.mode,
              v
            ), tu(v, d), v.return = h, v;
          case jl:
            return d = Bi(
              d,
              h.mode,
              v
            ), d.return = h, d;
          case Zl:
            return d = Ga(d), j(h, d, v);
        }
        if (At(d) || Vl(d))
          return d = Ca(
            d,
            h.mode,
            v,
            null
          ), d.return = h, d;
        if (typeof d.then == "function")
          return j(h, nn(d), v);
        if (d.$$typeof === Bl)
          return j(
            h,
            tn(h, d),
            v
          );
        cn(h, d);
      }
      return null;
    }
    function g(h, d, v, T) {
      var Y = d !== null ? d.key : null;
      if (typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint")
        return Y !== null ? null : c(h, d, "" + v, T);
      if (typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case ll:
            return v.key === Y ? s(h, d, v, T) : null;
          case jl:
            return v.key === Y ? y(h, d, v, T) : null;
          case Zl:
            return v = Ga(v), g(h, d, v, T);
        }
        if (At(v) || Vl(v))
          return Y !== null ? null : p(h, d, v, T, null);
        if (typeof v.then == "function")
          return g(
            h,
            d,
            nn(v),
            T
          );
        if (v.$$typeof === Bl)
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
    function S(h, d, v, T, Y) {
      if (typeof T == "string" && T !== "" || typeof T == "number" || typeof T == "bigint")
        return h = h.get(v) || null, c(d, h, "" + T, Y);
      if (typeof T == "object" && T !== null) {
        switch (T.$$typeof) {
          case ll:
            return h = h.get(
              T.key === null ? v : T.key
            ) || null, s(d, h, T, Y);
          case jl:
            return h = h.get(
              T.key === null ? v : T.key
            ) || null, y(d, h, T, Y);
          case Zl:
            return T = Ga(T), S(
              h,
              d,
              v,
              T,
              Y
            );
        }
        if (At(T) || Vl(T))
          return h = h.get(v) || null, p(d, h, T, Y, null);
        if (typeof T.then == "function")
          return S(
            h,
            d,
            v,
            nn(T),
            Y
          );
        if (T.$$typeof === Bl)
          return S(
            h,
            d,
            v,
            tn(d, T),
            Y
          );
        cn(d, T);
      }
      return null;
    }
    function R(h, d, v, T) {
      for (var Y = null, al = null, B = d, J = d = 0, F = null; B !== null && J < v.length; J++) {
        B.index > J ? (F = B, B = null) : F = B.sibling;
        var el = g(
          h,
          B,
          v[J],
          T
        );
        if (el === null) {
          B === null && (B = F);
          break;
        }
        l && B && el.alternate === null && t(h, B), d = n(el, d, J), al === null ? Y = el : al.sibling = el, al = el, B = F;
      }
      if (J === v.length)
        return a(h, B), P && Yt(h, J), Y;
      if (B === null) {
        for (; J < v.length; J++)
          B = j(h, v[J], T), B !== null && (d = n(
            B,
            d,
            J
          ), al === null ? Y = B : al.sibling = B, al = B);
        return P && Yt(h, J), Y;
      }
      for (B = e(B); J < v.length; J++)
        F = S(
          B,
          h,
          J,
          v[J],
          T
        ), F !== null && (l && F.alternate !== null && B.delete(
          F.key === null ? J : F.key
        ), d = n(
          F,
          d,
          J
        ), al === null ? Y = F : al.sibling = F, al = F);
      return l && B.forEach(function(Ea) {
        return t(h, Ea);
      }), P && Yt(h, J), Y;
    }
    function G(h, d, v, T) {
      if (v == null) throw Error(o(151));
      for (var Y = null, al = null, B = d, J = d = 0, F = null, el = v.next(); B !== null && !el.done; J++, el = v.next()) {
        B.index > J ? (F = B, B = null) : F = B.sibling;
        var Ea = g(h, B, el.value, T);
        if (Ea === null) {
          B === null && (B = F);
          break;
        }
        l && B && Ea.alternate === null && t(h, B), d = n(Ea, d, J), al === null ? Y = Ea : al.sibling = Ea, al = Ea, B = F;
      }
      if (el.done)
        return a(h, B), P && Yt(h, J), Y;
      if (B === null) {
        for (; !el.done; J++, el = v.next())
          el = j(h, el.value, T), el !== null && (d = n(el, d, J), al === null ? Y = el : al.sibling = el, al = el);
        return P && Yt(h, J), Y;
      }
      for (B = e(B); !el.done; J++, el = v.next())
        el = S(B, h, J, el.value, T), el !== null && (l && el.alternate !== null && B.delete(el.key === null ? J : el.key), d = n(el, d, J), al === null ? Y = el : al.sibling = el, al = el);
      return l && B.forEach(function(rv) {
        return t(h, rv);
      }), P && Yt(h, J), Y;
    }
    function ml(h, d, v, T) {
      if (typeof v == "object" && v !== null && v.type === ul && v.key === null && (v = v.props.children), typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case ll:
            l: {
              for (var Y = v.key; d !== null; ) {
                if (d.key === Y) {
                  if (Y = v.type, Y === ul) {
                    if (d.tag === 7) {
                      a(
                        h,
                        d.sibling
                      ), T = u(
                        d,
                        v.props.children
                      ), T.return = h, h = T;
                      break l;
                    }
                  } else if (d.elementType === Y || typeof Y == "object" && Y !== null && Y.$$typeof === Zl && Ga(Y) === d.type) {
                    a(
                      h,
                      d.sibling
                    ), T = u(d, v.props), tu(T, v), T.return = h, h = T;
                    break l;
                  }
                  a(h, d);
                  break;
                } else t(h, d);
                d = d.sibling;
              }
              v.type === ul ? (T = Ca(
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
          case jl:
            l: {
              for (Y = v.key; d !== null; ) {
                if (d.key === Y)
                  if (d.tag === 4 && d.stateNode.containerInfo === v.containerInfo && d.stateNode.implementation === v.implementation) {
                    a(
                      h,
                      d.sibling
                    ), T = u(d, v.children || []), T.return = h, h = T;
                    break l;
                  } else {
                    a(h, d);
                    break;
                  }
                else t(h, d);
                d = d.sibling;
              }
              T = Bi(v, h.mode, T), T.return = h, h = T;
            }
            return i(h);
          case Zl:
            return v = Ga(v), ml(
              h,
              d,
              v,
              T
            );
        }
        if (At(v))
          return R(
            h,
            d,
            v,
            T
          );
        if (Vl(v)) {
          if (Y = Vl(v), typeof Y != "function") throw Error(o(150));
          return v = Y.call(v), G(
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
        if (v.$$typeof === Bl)
          return ml(
            h,
            d,
            tn(h, v),
            T
          );
        cn(h, v);
      }
      return typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint" ? (v = "" + v, d !== null && d.tag === 6 ? (a(h, d.sibling), T = u(d, v), T.return = h, h = T) : (a(h, d), T = qi(v, h.mode, T), T.return = h, h = T), i(h)) : a(h, d);
    }
    return function(h, d, v, T) {
      try {
        lu = 0;
        var Y = ml(
          h,
          d,
          v,
          T
        );
        return ge = null, Y;
      } catch (B) {
        if (B === ye || B === en) throw B;
        var al = et(29, B, null, h.mode);
        return al.lanes = T, al.return = h, al;
      }
    };
  }
  var Xa = Zs(!0), Vs = Zs(!1), fa = !1;
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
  function sa(l) {
    return { lane: l, tag: 0, payload: null, callback: null, next: null };
  }
  function da(l, t, a) {
    var e = l.updateQueue;
    if (e === null) return null;
    if (e = e.shared, (nl & 2) !== 0) {
      var u = e.pending;
      return u === null ? t.next = t : (t.next = u.next, u.next = t), e.pending = t, t = Fu(l), _s(l, null, a), t;
    }
    return ku(l, e, t, a), Fu(l);
  }
  function au(l, t, a) {
    if (t = t.updateQueue, t !== null && (t = t.shared, (a & 4194048) !== 0)) {
      var e = t.lanes;
      e &= l.pendingLanes, a |= e, t.lanes = a, Hf(l, a);
    }
  }
  function Fi(l, t) {
    var a = l.updateQueue, e = l.alternate;
    if (e !== null && (e = e.updateQueue, a === e)) {
      var u = null, n = null;
      if (a = a.firstBaseUpdate, a !== null) {
        do {
          var i = {
            lane: a.lane,
            tag: a.tag,
            payload: a.payload,
            callback: null,
            next: null
          };
          n === null ? u = n = i : n = n.next = i, a = a.next;
        } while (a !== null);
        n === null ? u = n = t : n = n.next = t;
      } else u = n = t;
      a = {
        baseState: e.baseState,
        firstBaseUpdate: u,
        lastBaseUpdate: n,
        shared: e.shared,
        callbacks: e.callbacks
      }, l.updateQueue = a;
      return;
    }
    l = a.lastBaseUpdate, l === null ? a.firstBaseUpdate = t : l.next = t, a.lastBaseUpdate = t;
  }
  var Ii = !1;
  function eu() {
    if (Ii) {
      var l = ve;
      if (l !== null) throw l;
    }
  }
  function uu(l, t, a, e) {
    Ii = !1;
    var u = l.updateQueue;
    fa = !1;
    var n = u.firstBaseUpdate, i = u.lastBaseUpdate, c = u.shared.pending;
    if (c !== null) {
      u.shared.pending = null;
      var s = c, y = s.next;
      s.next = null, i === null ? n = y : i.next = y, i = s;
      var p = l.alternate;
      p !== null && (p = p.updateQueue, c = p.lastBaseUpdate, c !== i && (c === null ? p.firstBaseUpdate = y : c.next = y, p.lastBaseUpdate = s));
    }
    if (n !== null) {
      var j = u.baseState;
      i = 0, p = y = s = null, c = n;
      do {
        var g = c.lane & -536870913, S = g !== c.lane;
        if (S ? (k & g) === g : (e & g) === g) {
          g !== 0 && g === he && (Ii = !0), p !== null && (p = p.next = {
            lane: 0,
            tag: c.tag,
            payload: c.payload,
            callback: null,
            next: null
          });
          l: {
            var R = l, G = c;
            g = t;
            var ml = a;
            switch (G.tag) {
              case 1:
                if (R = G.payload, typeof R == "function") {
                  j = R.call(ml, j, g);
                  break l;
                }
                j = R;
                break l;
              case 3:
                R.flags = R.flags & -65537 | 128;
              case 0:
                if (R = G.payload, g = typeof R == "function" ? R.call(ml, j, g) : R, g == null) break l;
                j = A({}, j, g);
                break l;
              case 2:
                fa = !0;
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
          }, p === null ? (y = p = S, s = j) : p = p.next = S, i |= g;
        if (c = c.next, c === null) {
          if (c = u.shared.pending, c === null)
            break;
          S = c, c = S.next, S.next = null, u.lastBaseUpdate = S, u.shared.pending = null;
        }
      } while (!0);
      p === null && (s = j), u.baseState = s, u.firstBaseUpdate = y, u.lastBaseUpdate = p, n === null && (u.shared.lanes = 0), va |= i, l.lanes = i, l.memoizedState = j;
    }
  }
  function Ks(l, t) {
    if (typeof l != "function")
      throw Error(o(191, l));
    l.call(t);
  }
  function Js(l, t) {
    var a = l.callbacks;
    if (a !== null)
      for (l.callbacks = null, l = 0; l < a.length; l++)
        Ks(a[l], t);
  }
  var Se = m(null), fn = m(0);
  function ws(l, t) {
    l = Wt, U(fn, l), U(Se, t), Wt = l | t.baseLanes;
  }
  function Pi() {
    U(fn, Wt), U(Se, Se.current);
  }
  function lc() {
    Wt = fn.current, E(Se), E(fn);
  }
  var ut = m(null), bt = null;
  function oa(l) {
    var t = l.alternate;
    U(Al, Al.current & 1), U(ut, l), bt === null && (t === null || Se.current !== null || t.memoizedState !== null) && (bt = l);
  }
  function tc(l) {
    U(Al, Al.current), U(ut, l), bt === null && (bt = l);
  }
  function $s(l) {
    l.tag === 22 ? (U(Al, Al.current), U(ut, l), bt === null && (bt = l)) : ma();
  }
  function ma() {
    U(Al, Al.current), U(ut, ut.current);
  }
  function nt(l) {
    E(ut), bt === l && (bt = null), E(Al);
  }
  var Al = m(0);
  function sn(l) {
    for (var t = l; t !== null; ) {
      if (t.tag === 13) {
        var a = t.memoizedState;
        if (a !== null && (a = a.dehydrated, a === null || ff(a) || sf(a)))
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
  var Xt = 0, K = null, dl = null, xl = null, dn = !1, be = !1, La = !1, on = 0, nu = 0, pe = null, eh = 0;
  function bl() {
    throw Error(o(321));
  }
  function ac(l, t) {
    if (t === null) return !1;
    for (var a = 0; a < t.length && a < l.length; a++)
      if (!at(l[a], t[a])) return !1;
    return !0;
  }
  function ec(l, t, a, e, u, n) {
    return Xt = n, K = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, z.H = l === null || l.memoizedState === null ? Dd : Sc, La = !1, n = a(e, u), La = !1, be && (n = ks(
      t,
      a,
      e,
      u
    )), Ws(l), n;
  }
  function Ws(l) {
    z.H = fu;
    var t = dl !== null && dl.next !== null;
    if (Xt = 0, xl = dl = K = null, dn = !1, nu = 0, pe = null, t) throw Error(o(300));
    l === null || _l || (l = l.dependencies, l !== null && ln(l) && (_l = !0));
  }
  function ks(l, t, a, e) {
    K = l;
    var u = 0;
    do {
      if (be && (pe = null), nu = 0, be = !1, 25 <= u) throw Error(o(301));
      if (u += 1, xl = dl = null, l.updateQueue != null) {
        var n = l.updateQueue;
        n.lastEffect = null, n.events = null, n.stores = null, n.memoCache != null && (n.memoCache.index = 0);
      }
      z.H = Ud, n = t(a, e);
    } while (be);
    return n;
  }
  function uh() {
    var l = z.H, t = l.useState()[0];
    return t = typeof t.then == "function" ? iu(t) : t, l = l.useState()[0], (dl !== null ? dl.memoizedState : null) !== l && (K.flags |= 1024), t;
  }
  function uc() {
    var l = on !== 0;
    return on = 0, l;
  }
  function nc(l, t, a) {
    t.updateQueue = l.updateQueue, t.flags &= -2053, l.lanes &= ~a;
  }
  function ic(l) {
    if (dn) {
      for (l = l.memoizedState; l !== null; ) {
        var t = l.queue;
        t !== null && (t.pending = null), l = l.next;
      }
      dn = !1;
    }
    Xt = 0, xl = dl = K = null, be = !1, nu = on = 0, pe = null;
  }
  function Ql() {
    var l = {
      memoizedState: null,
      baseState: null,
      baseQueue: null,
      queue: null,
      next: null
    };
    return xl === null ? K.memoizedState = xl = l : xl = xl.next = l, xl;
  }
  function Tl() {
    if (dl === null) {
      var l = K.alternate;
      l = l !== null ? l.memoizedState : null;
    } else l = dl.next;
    var t = xl === null ? K.memoizedState : xl.next;
    if (t !== null)
      xl = t, dl = l;
    else {
      if (l === null)
        throw K.alternate === null ? Error(o(467)) : Error(o(310));
      dl = l, l = {
        memoizedState: dl.memoizedState,
        baseState: dl.baseState,
        baseQueue: dl.baseQueue,
        queue: dl.queue,
        next: null
      }, xl === null ? K.memoizedState = xl = l : xl = xl.next = l;
    }
    return xl;
  }
  function mn() {
    return { lastEffect: null, events: null, stores: null, memoCache: null };
  }
  function iu(l) {
    var t = nu;
    return nu += 1, pe === null && (pe = []), l = Qs(pe, l, t), t = K, (xl === null ? t.memoizedState : xl.next) === null && (t = t.alternate, z.H = t === null || t.memoizedState === null ? Dd : Sc), l;
  }
  function rn(l) {
    if (l !== null && typeof l == "object") {
      if (typeof l.then == "function") return iu(l);
      if (l.$$typeof === Bl) return Cl(l);
    }
    throw Error(o(438, String(l)));
  }
  function cc(l) {
    var t = null, a = K.updateQueue;
    if (a !== null && (t = a.memoCache), t == null) {
      var e = K.alternate;
      e !== null && (e = e.updateQueue, e !== null && (e = e.memoCache, e != null && (t = {
        data: e.data.map(function(u) {
          return u.slice();
        }),
        index: 0
      })));
    }
    if (t == null && (t = { data: [], index: 0 }), a === null && (a = mn(), K.updateQueue = a), a.memoCache = t, a = t.data[t.index], a === void 0)
      for (a = t.data[t.index] = Array(l), e = 0; e < l; e++)
        a[e] = Wa;
    return t.index++, a;
  }
  function Lt(l, t) {
    return typeof t == "function" ? t(l) : t;
  }
  function hn(l) {
    var t = Tl();
    return fc(t, dl, l);
  }
  function fc(l, t, a) {
    var e = l.queue;
    if (e === null) throw Error(o(311));
    e.lastRenderedReducer = a;
    var u = l.baseQueue, n = e.pending;
    if (n !== null) {
      if (u !== null) {
        var i = u.next;
        u.next = n.next, n.next = i;
      }
      t.baseQueue = u = n, e.pending = null;
    }
    if (n = l.baseState, u === null) l.memoizedState = n;
    else {
      t = u.next;
      var c = i = null, s = null, y = t, p = !1;
      do {
        var j = y.lane & -536870913;
        if (j !== y.lane ? (k & j) === j : (Xt & j) === j) {
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
            }), j === he && (p = !0);
          else if ((Xt & g) === g) {
            y = y.next, g === he && (p = !0);
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
            }, s === null ? (c = s = j, i = n) : s = s.next = j, K.lanes |= g, va |= g;
          j = y.action, La && a(n, j), n = y.hasEagerState ? y.eagerState : a(n, j);
        } else
          g = {
            lane: j,
            revertLane: y.revertLane,
            gesture: y.gesture,
            action: y.action,
            hasEagerState: y.hasEagerState,
            eagerState: y.eagerState,
            next: null
          }, s === null ? (c = s = g, i = n) : s = s.next = g, K.lanes |= j, va |= j;
        y = y.next;
      } while (y !== null && y !== t);
      if (s === null ? i = n : s.next = c, !at(n, l.memoizedState) && (_l = !0, p && (a = ve, a !== null)))
        throw a;
      l.memoizedState = n, l.baseState = i, l.baseQueue = s, e.lastRenderedState = n;
    }
    return u === null && (e.lanes = 0), [l.memoizedState, e.dispatch];
  }
  function sc(l) {
    var t = Tl(), a = t.queue;
    if (a === null) throw Error(o(311));
    a.lastRenderedReducer = l;
    var e = a.dispatch, u = a.pending, n = t.memoizedState;
    if (u !== null) {
      a.pending = null;
      var i = u = u.next;
      do
        n = l(n, i.action), i = i.next;
      while (i !== u);
      at(n, t.memoizedState) || (_l = !0), t.memoizedState = n, t.baseQueue === null && (t.baseState = n), a.lastRenderedState = n;
    }
    return [n, e];
  }
  function Fs(l, t, a) {
    var e = K, u = Tl(), n = P;
    if (n) {
      if (a === void 0) throw Error(o(407));
      a = a();
    } else a = t();
    var i = !at(
      (dl || u).memoizedState,
      a
    );
    if (i && (u.memoizedState = a, _l = !0), u = u.queue, mc(ld.bind(null, e, u, l), [
      l
    ]), u.getSnapshot !== t || i || xl !== null && xl.memoizedState.tag & 1) {
      if (e.flags |= 2048, ze(
        9,
        { destroy: void 0 },
        Ps.bind(
          null,
          e,
          u,
          a,
          t
        ),
        null
      ), hl === null) throw Error(o(349));
      n || (Xt & 127) !== 0 || Is(e, t, a);
    }
    return a;
  }
  function Is(l, t, a) {
    l.flags |= 16384, l = { getSnapshot: t, value: a }, t = K.updateQueue, t === null ? (t = mn(), K.updateQueue = t, t.stores = [l]) : (a = t.stores, a === null ? t.stores = [l] : a.push(l));
  }
  function Ps(l, t, a, e) {
    t.value = a, t.getSnapshot = e, td(t) && ad(l);
  }
  function ld(l, t, a) {
    return a(function() {
      td(t) && ad(l);
    });
  }
  function td(l) {
    var t = l.getSnapshot;
    l = l.value;
    try {
      var a = t();
      return !at(l, a);
    } catch {
      return !0;
    }
  }
  function ad(l) {
    var t = Ra(l, 2);
    t !== null && Fl(t, l, 2);
  }
  function dc(l) {
    var t = Ql();
    if (typeof l == "function") {
      var a = l;
      if (l = a(), La) {
        ta(!0);
        try {
          a();
        } finally {
          ta(!1);
        }
      }
    }
    return t.memoizedState = t.baseState = l, t.queue = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: Lt,
      lastRenderedState: l
    }, t;
  }
  function ed(l, t, a, e) {
    return l.baseState = a, fc(
      l,
      dl,
      typeof e == "function" ? e : Lt
    );
  }
  function nh(l, t, a, e, u) {
    if (gn(l)) throw Error(o(485));
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
      z.T !== null ? a(!0) : n.isTransition = !1, e(n), a = t.pending, a === null ? (n.next = t.pending = n, ud(t, n)) : (n.next = a.next, t.pending = a.next = n);
    }
  }
  function ud(l, t) {
    var a = t.action, e = t.payload, u = l.state;
    if (t.isTransition) {
      var n = z.T, i = {};
      z.T = i;
      try {
        var c = a(u, e), s = z.S;
        s !== null && s(i, c), nd(l, t, c);
      } catch (y) {
        oc(l, t, y);
      } finally {
        n !== null && i.types !== null && (n.types = i.types), z.T = n;
      }
    } else
      try {
        n = a(u, e), nd(l, t, n);
      } catch (y) {
        oc(l, t, y);
      }
  }
  function nd(l, t, a) {
    a !== null && typeof a == "object" && typeof a.then == "function" ? a.then(
      function(e) {
        id(l, t, e);
      },
      function(e) {
        return oc(l, t, e);
      }
    ) : id(l, t, a);
  }
  function id(l, t, a) {
    t.status = "fulfilled", t.value = a, cd(t), l.state = a, t = l.pending, t !== null && (a = t.next, a === t ? l.pending = null : (a = a.next, t.next = a, ud(l, a)));
  }
  function oc(l, t, a) {
    var e = l.pending;
    if (l.pending = null, e !== null) {
      e = e.next;
      do
        t.status = "rejected", t.reason = a, cd(t), t = t.next;
      while (t !== e);
    }
    l.action = null;
  }
  function cd(l) {
    l = l.listeners;
    for (var t = 0; t < l.length; t++) (0, l[t])();
  }
  function fd(l, t) {
    return t;
  }
  function sd(l, t) {
    if (P) {
      var a = hl.formState;
      if (a !== null) {
        l: {
          var e = K;
          if (P) {
            if (vl) {
              t: {
                for (var u = vl, n = St; u.nodeType !== 8; ) {
                  if (!n) {
                    u = null;
                    break t;
                  }
                  if (u = pt(
                    u.nextSibling
                  ), u === null) {
                    u = null;
                    break t;
                  }
                }
                n = u.data, u = n === "F!" || n === "F" ? u : null;
              }
              if (u) {
                vl = pt(
                  u.nextSibling
                ), e = u.data === "F!";
                break l;
              }
            }
            ia(e);
          }
          e = !1;
        }
        e && (t = a[0]);
      }
    }
    return a = Ql(), a.memoizedState = a.baseState = t, e = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: fd,
      lastRenderedState: t
    }, a.queue = e, a = Od.bind(
      null,
      K,
      e
    ), e.dispatch = a, e = dc(!1), n = gc.bind(
      null,
      K,
      !1,
      e.queue
    ), e = Ql(), u = {
      state: t,
      dispatch: null,
      action: l,
      pending: null
    }, e.queue = u, a = nh.bind(
      null,
      K,
      u,
      n,
      a
    ), u.dispatch = a, e.memoizedState = l, [t, a, !1];
  }
  function dd(l) {
    var t = Tl();
    return od(t, dl, l);
  }
  function od(l, t, a) {
    if (t = fc(
      l,
      t,
      fd
    )[0], l = hn(Lt)[0], typeof t == "object" && t !== null && typeof t.then == "function")
      try {
        var e = iu(t);
      } catch (i) {
        throw i === ye ? en : i;
      }
    else e = t;
    t = Tl();
    var u = t.queue, n = u.dispatch;
    return a !== t.memoizedState && (K.flags |= 2048, ze(
      9,
      { destroy: void 0 },
      ih.bind(null, u, a),
      null
    )), [e, n, l];
  }
  function ih(l, t) {
    l.action = t;
  }
  function md(l) {
    var t = Tl(), a = dl;
    if (a !== null)
      return od(t, a, l);
    Tl(), t = t.memoizedState, a = Tl();
    var e = a.queue.dispatch;
    return a.memoizedState = l, [t, e, !1];
  }
  function ze(l, t, a, e) {
    return l = { tag: l, create: a, deps: e, inst: t, next: null }, t = K.updateQueue, t === null && (t = mn(), K.updateQueue = t), a = t.lastEffect, a === null ? t.lastEffect = l.next = l : (e = a.next, a.next = l, l.next = e, t.lastEffect = l), l;
  }
  function rd() {
    return Tl().memoizedState;
  }
  function vn(l, t, a, e) {
    var u = Ql();
    K.flags |= l, u.memoizedState = ze(
      1 | t,
      { destroy: void 0 },
      a,
      e === void 0 ? null : e
    );
  }
  function yn(l, t, a, e) {
    var u = Tl();
    e = e === void 0 ? null : e;
    var n = u.memoizedState.inst;
    dl !== null && e !== null && ac(e, dl.memoizedState.deps) ? u.memoizedState = ze(t, n, a, e) : (K.flags |= l, u.memoizedState = ze(
      1 | t,
      n,
      a,
      e
    ));
  }
  function hd(l, t) {
    vn(8390656, 8, l, t);
  }
  function mc(l, t) {
    yn(2048, 8, l, t);
  }
  function ch(l) {
    K.flags |= 4;
    var t = K.updateQueue;
    if (t === null)
      t = mn(), K.updateQueue = t, t.events = [l];
    else {
      var a = t.events;
      a === null ? t.events = [l] : a.push(l);
    }
  }
  function vd(l) {
    var t = Tl().memoizedState;
    return ch({ ref: t, nextImpl: l }), function() {
      if ((nl & 2) !== 0) throw Error(o(440));
      return t.impl.apply(void 0, arguments);
    };
  }
  function yd(l, t) {
    return yn(4, 2, l, t);
  }
  function gd(l, t) {
    return yn(4, 4, l, t);
  }
  function Sd(l, t) {
    if (typeof t == "function") {
      l = l();
      var a = t(l);
      return function() {
        typeof a == "function" ? a() : t(null);
      };
    }
    if (t != null)
      return l = l(), t.current = l, function() {
        t.current = null;
      };
  }
  function bd(l, t, a) {
    a = a != null ? a.concat([l]) : null, yn(4, 4, Sd.bind(null, t, l), a);
  }
  function rc() {
  }
  function pd(l, t) {
    var a = Tl();
    t = t === void 0 ? null : t;
    var e = a.memoizedState;
    return t !== null && ac(t, e[1]) ? e[0] : (a.memoizedState = [l, t], l);
  }
  function zd(l, t) {
    var a = Tl();
    t = t === void 0 ? null : t;
    var e = a.memoizedState;
    if (t !== null && ac(t, e[1]))
      return e[0];
    if (e = l(), La) {
      ta(!0);
      try {
        l();
      } finally {
        ta(!1);
      }
    }
    return a.memoizedState = [e, t], e;
  }
  function hc(l, t, a) {
    return a === void 0 || (Xt & 1073741824) !== 0 && (k & 261930) === 0 ? l.memoizedState = t : (l.memoizedState = a, l = To(), K.lanes |= l, va |= l, a);
  }
  function Ad(l, t, a, e) {
    return at(a, t) ? a : Se.current !== null ? (l = hc(l, a, e), at(l, t) || (_l = !0), l) : (Xt & 42) === 0 || (Xt & 1073741824) !== 0 && (k & 261930) === 0 ? (_l = !0, l.memoizedState = a) : (l = To(), K.lanes |= l, va |= l, t);
  }
  function Td(l, t, a, e, u) {
    var n = D.p;
    D.p = n !== 0 && 8 > n ? n : 8;
    var i = z.T, c = {};
    z.T = c, gc(l, !1, t, a);
    try {
      var s = u(), y = z.S;
      if (y !== null && y(c, s), s !== null && typeof s == "object" && typeof s.then == "function") {
        var p = ah(
          s,
          e
        );
        cu(
          l,
          t,
          p,
          ft(l)
        );
      } else
        cu(
          l,
          t,
          e,
          ft(l)
        );
    } catch (j) {
      cu(
        l,
        t,
        { then: function() {
        }, status: "rejected", reason: j },
        ft()
      );
    } finally {
      D.p = n, i !== null && c.types !== null && (i.types = c.types), z.T = i;
    }
  }
  function fh() {
  }
  function vc(l, t, a, e) {
    if (l.tag !== 5) throw Error(o(476));
    var u = jd(l).queue;
    Td(
      l,
      u,
      t,
      Q,
      a === null ? fh : function() {
        return Ed(l), a(e);
      }
    );
  }
  function jd(l) {
    var t = l.memoizedState;
    if (t !== null) return t;
    t = {
      memoizedState: Q,
      baseState: Q,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Lt,
        lastRenderedState: Q
      },
      next: null
    };
    var a = {};
    return t.next = {
      memoizedState: a,
      baseState: a,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Lt,
        lastRenderedState: a
      },
      next: null
    }, l.memoizedState = t, l = l.alternate, l !== null && (l.memoizedState = t), t;
  }
  function Ed(l) {
    var t = jd(l);
    t.next === null && (t = l.alternate.memoizedState), cu(
      l,
      t.next.queue,
      {},
      ft()
    );
  }
  function yc() {
    return Cl(ju);
  }
  function xd() {
    return Tl().memoizedState;
  }
  function _d() {
    return Tl().memoizedState;
  }
  function sh(l) {
    for (var t = l.return; t !== null; ) {
      switch (t.tag) {
        case 24:
        case 3:
          var a = ft();
          l = sa(a);
          var e = da(t, l, a);
          e !== null && (Fl(e, t, a), au(e, t, a)), t = { cache: Ki() }, l.payload = t;
          return;
      }
      t = t.return;
    }
  }
  function dh(l, t, a) {
    var e = ft();
    a = {
      lane: e,
      revertLane: 0,
      gesture: null,
      action: a,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, gn(l) ? Nd(t, a) : (a = Ci(l, t, a, e), a !== null && (Fl(a, l, e), Md(a, t, e)));
  }
  function Od(l, t, a) {
    var e = ft();
    cu(l, t, a, e);
  }
  function cu(l, t, a, e) {
    var u = {
      lane: e,
      revertLane: 0,
      gesture: null,
      action: a,
      hasEagerState: !1,
      eagerState: null,
      next: null
    };
    if (gn(l)) Nd(t, u);
    else {
      var n = l.alternate;
      if (l.lanes === 0 && (n === null || n.lanes === 0) && (n = t.lastRenderedReducer, n !== null))
        try {
          var i = t.lastRenderedState, c = n(i, a);
          if (u.hasEagerState = !0, u.eagerState = c, at(c, i))
            return ku(l, t, u, 0), hl === null && Wu(), !1;
        } catch {
        }
      if (a = Ci(l, t, u, e), a !== null)
        return Fl(a, l, e), Md(a, t, e), !0;
    }
    return !1;
  }
  function gc(l, t, a, e) {
    if (e = {
      lane: 2,
      revertLane: Wc(),
      gesture: null,
      action: e,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, gn(l)) {
      if (t) throw Error(o(479));
    } else
      t = Ci(
        l,
        a,
        e,
        2
      ), t !== null && Fl(t, l, 2);
  }
  function gn(l) {
    var t = l.alternate;
    return l === K || t !== null && t === K;
  }
  function Nd(l, t) {
    be = dn = !0;
    var a = l.pending;
    a === null ? t.next = t : (t.next = a.next, a.next = t), l.pending = t;
  }
  function Md(l, t, a) {
    if ((a & 4194048) !== 0) {
      var e = t.lanes;
      e &= l.pendingLanes, a |= e, t.lanes = a, Hf(l, a);
    }
  }
  var fu = {
    readContext: Cl,
    use: rn,
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
  fu.useEffectEvent = bl;
  var Dd = {
    readContext: Cl,
    use: rn,
    useCallback: function(l, t) {
      return Ql().memoizedState = [
        l,
        t === void 0 ? null : t
      ], l;
    },
    useContext: Cl,
    useEffect: hd,
    useImperativeHandle: function(l, t, a) {
      a = a != null ? a.concat([l]) : null, vn(
        4194308,
        4,
        Sd.bind(null, t, l),
        a
      );
    },
    useLayoutEffect: function(l, t) {
      return vn(4194308, 4, l, t);
    },
    useInsertionEffect: function(l, t) {
      vn(4, 2, l, t);
    },
    useMemo: function(l, t) {
      var a = Ql();
      t = t === void 0 ? null : t;
      var e = l();
      if (La) {
        ta(!0);
        try {
          l();
        } finally {
          ta(!1);
        }
      }
      return a.memoizedState = [e, t], e;
    },
    useReducer: function(l, t, a) {
      var e = Ql();
      if (a !== void 0) {
        var u = a(t);
        if (La) {
          ta(!0);
          try {
            a(t);
          } finally {
            ta(!1);
          }
        }
      } else u = t;
      return e.memoizedState = e.baseState = u, l = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: l,
        lastRenderedState: u
      }, e.queue = l, l = l.dispatch = dh.bind(
        null,
        K,
        l
      ), [e.memoizedState, l];
    },
    useRef: function(l) {
      var t = Ql();
      return l = { current: l }, t.memoizedState = l;
    },
    useState: function(l) {
      l = dc(l);
      var t = l.queue, a = Od.bind(null, K, t);
      return t.dispatch = a, [l.memoizedState, a];
    },
    useDebugValue: rc,
    useDeferredValue: function(l, t) {
      var a = Ql();
      return hc(a, l, t);
    },
    useTransition: function() {
      var l = dc(!1);
      return l = Td.bind(
        null,
        K,
        l.queue,
        !0,
        !1
      ), Ql().memoizedState = l, [!1, l];
    },
    useSyncExternalStore: function(l, t, a) {
      var e = K, u = Ql();
      if (P) {
        if (a === void 0)
          throw Error(o(407));
        a = a();
      } else {
        if (a = t(), hl === null)
          throw Error(o(349));
        (k & 127) !== 0 || Is(e, t, a);
      }
      u.memoizedState = a;
      var n = { value: a, getSnapshot: t };
      return u.queue = n, hd(ld.bind(null, e, n, l), [
        l
      ]), e.flags |= 2048, ze(
        9,
        { destroy: void 0 },
        Ps.bind(
          null,
          e,
          n,
          a,
          t
        ),
        null
      ), a;
    },
    useId: function() {
      var l = Ql(), t = hl.identifierPrefix;
      if (P) {
        var a = Mt, e = Nt;
        a = (e & ~(1 << 32 - tt(e) - 1)).toString(32) + a, t = "_" + t + "R_" + a, a = on++, 0 < a && (t += "H" + a.toString(32)), t += "_";
      } else
        a = eh++, t = "_" + t + "r_" + a.toString(32) + "_";
      return l.memoizedState = t;
    },
    useHostTransitionStatus: yc,
    useFormState: sd,
    useActionState: sd,
    useOptimistic: function(l) {
      var t = Ql();
      t.memoizedState = t.baseState = l;
      var a = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: null,
        lastRenderedState: null
      };
      return t.queue = a, t = gc.bind(
        null,
        K,
        !0,
        a
      ), a.dispatch = t, [l, t];
    },
    useMemoCache: cc,
    useCacheRefresh: function() {
      return Ql().memoizedState = sh.bind(
        null,
        K
      );
    },
    useEffectEvent: function(l) {
      var t = Ql(), a = { impl: l };
      return t.memoizedState = a, function() {
        if ((nl & 2) !== 0)
          throw Error(o(440));
        return a.impl.apply(void 0, arguments);
      };
    }
  }, Sc = {
    readContext: Cl,
    use: rn,
    useCallback: pd,
    useContext: Cl,
    useEffect: mc,
    useImperativeHandle: bd,
    useInsertionEffect: yd,
    useLayoutEffect: gd,
    useMemo: zd,
    useReducer: hn,
    useRef: rd,
    useState: function() {
      return hn(Lt);
    },
    useDebugValue: rc,
    useDeferredValue: function(l, t) {
      var a = Tl();
      return Ad(
        a,
        dl.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = hn(Lt)[0], t = Tl().memoizedState;
      return [
        typeof l == "boolean" ? l : iu(l),
        t
      ];
    },
    useSyncExternalStore: Fs,
    useId: xd,
    useHostTransitionStatus: yc,
    useFormState: dd,
    useActionState: dd,
    useOptimistic: function(l, t) {
      var a = Tl();
      return ed(a, dl, l, t);
    },
    useMemoCache: cc,
    useCacheRefresh: _d
  };
  Sc.useEffectEvent = vd;
  var Ud = {
    readContext: Cl,
    use: rn,
    useCallback: pd,
    useContext: Cl,
    useEffect: mc,
    useImperativeHandle: bd,
    useInsertionEffect: yd,
    useLayoutEffect: gd,
    useMemo: zd,
    useReducer: sc,
    useRef: rd,
    useState: function() {
      return sc(Lt);
    },
    useDebugValue: rc,
    useDeferredValue: function(l, t) {
      var a = Tl();
      return dl === null ? hc(a, l, t) : Ad(
        a,
        dl.memoizedState,
        l,
        t
      );
    },
    useTransition: function() {
      var l = sc(Lt)[0], t = Tl().memoizedState;
      return [
        typeof l == "boolean" ? l : iu(l),
        t
      ];
    },
    useSyncExternalStore: Fs,
    useId: xd,
    useHostTransitionStatus: yc,
    useFormState: md,
    useActionState: md,
    useOptimistic: function(l, t) {
      var a = Tl();
      return dl !== null ? ed(a, dl, l, t) : (a.baseState = l, [l, a.queue.dispatch]);
    },
    useMemoCache: cc,
    useCacheRefresh: _d
  };
  Ud.useEffectEvent = vd;
  function bc(l, t, a, e) {
    t = l.memoizedState, a = a(e, t), a = a == null ? t : A({}, t, a), l.memoizedState = a, l.lanes === 0 && (l.updateQueue.baseState = a);
  }
  var pc = {
    enqueueSetState: function(l, t, a) {
      l = l._reactInternals;
      var e = ft(), u = sa(e);
      u.payload = t, a != null && (u.callback = a), t = da(l, u, e), t !== null && (Fl(t, l, e), au(t, l, e));
    },
    enqueueReplaceState: function(l, t, a) {
      l = l._reactInternals;
      var e = ft(), u = sa(e);
      u.tag = 1, u.payload = t, a != null && (u.callback = a), t = da(l, u, e), t !== null && (Fl(t, l, e), au(t, l, e));
    },
    enqueueForceUpdate: function(l, t) {
      l = l._reactInternals;
      var a = ft(), e = sa(a);
      e.tag = 2, t != null && (e.callback = t), t = da(l, e, a), t !== null && (Fl(t, l, a), au(t, l, a));
    }
  };
  function Rd(l, t, a, e, u, n, i) {
    return l = l.stateNode, typeof l.shouldComponentUpdate == "function" ? l.shouldComponentUpdate(e, n, i) : t.prototype && t.prototype.isPureReactComponent ? !$e(a, e) || !$e(u, n) : !0;
  }
  function Cd(l, t, a, e) {
    l = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(a, e), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(a, e), t.state !== l && pc.enqueueReplaceState(t, t.state, null);
  }
  function Za(l, t) {
    var a = t;
    if ("ref" in t) {
      a = {};
      for (var e in t)
        e !== "ref" && (a[e] = t[e]);
    }
    if (l = l.defaultProps) {
      a === t && (a = A({}, a));
      for (var u in l)
        a[u] === void 0 && (a[u] = l[u]);
    }
    return a;
  }
  function Hd(l) {
    $u(l);
  }
  function qd(l) {
    console.error(l);
  }
  function Bd(l) {
    $u(l);
  }
  function Sn(l, t) {
    try {
      var a = l.onUncaughtError;
      a(t.value, { componentStack: t.stack });
    } catch (e) {
      setTimeout(function() {
        throw e;
      });
    }
  }
  function Yd(l, t, a) {
    try {
      var e = l.onCaughtError;
      e(a.value, {
        componentStack: a.stack,
        errorBoundary: t.tag === 1 ? t.stateNode : null
      });
    } catch (u) {
      setTimeout(function() {
        throw u;
      });
    }
  }
  function zc(l, t, a) {
    return a = sa(a), a.tag = 3, a.payload = { element: null }, a.callback = function() {
      Sn(l, t);
    }, a;
  }
  function Gd(l) {
    return l = sa(l), l.tag = 3, l;
  }
  function Qd(l, t, a, e) {
    var u = a.type.getDerivedStateFromError;
    if (typeof u == "function") {
      var n = e.value;
      l.payload = function() {
        return u(n);
      }, l.callback = function() {
        Yd(t, a, e);
      };
    }
    var i = a.stateNode;
    i !== null && typeof i.componentDidCatch == "function" && (l.callback = function() {
      Yd(t, a, e), typeof u != "function" && (ya === null ? ya = /* @__PURE__ */ new Set([this]) : ya.add(this));
      var c = e.stack;
      this.componentDidCatch(e.value, {
        componentStack: c !== null ? c : ""
      });
    });
  }
  function oh(l, t, a, e, u) {
    if (a.flags |= 32768, e !== null && typeof e == "object" && typeof e.then == "function") {
      if (t = a.alternate, t !== null && re(
        t,
        a,
        u,
        !0
      ), a = ut.current, a !== null) {
        switch (a.tag) {
          case 31:
          case 13:
            return bt === null ? Mn() : a.alternate === null && pl === 0 && (pl = 3), a.flags &= -257, a.flags |= 65536, a.lanes = u, e === un ? a.flags |= 16384 : (t = a.updateQueue, t === null ? a.updateQueue = /* @__PURE__ */ new Set([e]) : t.add(e), Jc(l, e, u)), !1;
          case 22:
            return a.flags |= 65536, e === un ? a.flags |= 16384 : (t = a.updateQueue, t === null ? (t = {
              transitions: null,
              markerInstances: null,
              retryQueue: /* @__PURE__ */ new Set([e])
            }, a.updateQueue = t) : (a = t.retryQueue, a === null ? t.retryQueue = /* @__PURE__ */ new Set([e]) : a.add(e)), Jc(l, e, u)), !1;
        }
        throw Error(o(435, a.tag));
      }
      return Jc(l, e, u), Mn(), !1;
    }
    if (P)
      return t = ut.current, t !== null ? ((t.flags & 65536) === 0 && (t.flags |= 256), t.flags |= 65536, t.lanes = u, e !== Qi && (l = Error(o(422), { cause: e }), Fe(vt(l, a)))) : (e !== Qi && (t = Error(o(423), {
        cause: e
      }), Fe(
        vt(t, a)
      )), l = l.current.alternate, l.flags |= 65536, u &= -u, l.lanes |= u, e = vt(e, a), u = zc(
        l.stateNode,
        e,
        u
      ), Fi(l, u), pl !== 4 && (pl = 2)), !1;
    var n = Error(o(520), { cause: e });
    if (n = vt(n, a), yu === null ? yu = [n] : yu.push(n), pl !== 4 && (pl = 2), t === null) return !0;
    e = vt(e, a), a = t;
    do {
      switch (a.tag) {
        case 3:
          return a.flags |= 65536, l = u & -u, a.lanes |= l, l = zc(a.stateNode, e, l), Fi(a, l), !1;
        case 1:
          if (t = a.type, n = a.stateNode, (a.flags & 128) === 0 && (typeof t.getDerivedStateFromError == "function" || n !== null && typeof n.componentDidCatch == "function" && (ya === null || !ya.has(n))))
            return a.flags |= 65536, u &= -u, a.lanes |= u, u = Gd(u), Qd(
              u,
              l,
              a,
              e
            ), Fi(a, u), !1;
      }
      a = a.return;
    } while (a !== null);
    return !1;
  }
  var Ac = Error(o(461)), _l = !1;
  function Hl(l, t, a, e) {
    t.child = l === null ? Vs(t, null, a, e) : Xa(
      t,
      l.child,
      a,
      e
    );
  }
  function Xd(l, t, a, e, u) {
    a = a.render;
    var n = t.ref;
    if ("ref" in e) {
      var i = {};
      for (var c in e)
        c !== "ref" && (i[c] = e[c]);
    } else i = e;
    return Ba(t), e = ec(
      l,
      t,
      a,
      i,
      n,
      u
    ), c = uc(), l !== null && !_l ? (nc(l, t, u), Zt(l, t, u)) : (P && c && Yi(t), t.flags |= 1, Hl(l, t, e, u), t.child);
  }
  function Ld(l, t, a, e, u) {
    if (l === null) {
      var n = a.type;
      return typeof n == "function" && !Hi(n) && n.defaultProps === void 0 && a.compare === null ? (t.tag = 15, t.type = n, Zd(
        l,
        t,
        n,
        e,
        u
      )) : (l = Iu(
        a.type,
        null,
        e,
        t,
        t.mode,
        u
      ), l.ref = t.ref, l.return = t, t.child = l);
    }
    if (n = l.child, !Mc(l, u)) {
      var i = n.memoizedProps;
      if (a = a.compare, a = a !== null ? a : $e, a(i, e) && l.ref === t.ref)
        return Zt(l, t, u);
    }
    return t.flags |= 1, l = Bt(n, e), l.ref = t.ref, l.return = t, t.child = l;
  }
  function Zd(l, t, a, e, u) {
    if (l !== null) {
      var n = l.memoizedProps;
      if ($e(n, e) && l.ref === t.ref)
        if (_l = !1, t.pendingProps = e = n, Mc(l, u))
          (l.flags & 131072) !== 0 && (_l = !0);
        else
          return t.lanes = l.lanes, Zt(l, t, u);
    }
    return Tc(
      l,
      t,
      a,
      e,
      u
    );
  }
  function Vd(l, t, a, e) {
    var u = e.children, n = l !== null ? l.memoizedState : null;
    if (l === null && t.stateNode === null && (t.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), e.mode === "hidden") {
      if ((t.flags & 128) !== 0) {
        if (n = n !== null ? n.baseLanes | a : a, l !== null) {
          for (e = t.child = l.child, u = 0; e !== null; )
            u = u | e.lanes | e.childLanes, e = e.sibling;
          e = u & ~n;
        } else e = 0, t.child = null;
        return Kd(
          l,
          t,
          n,
          a,
          e
        );
      }
      if ((a & 536870912) !== 0)
        t.memoizedState = { baseLanes: 0, cachePool: null }, l !== null && an(
          t,
          n !== null ? n.cachePool : null
        ), n !== null ? ws(t, n) : Pi(), $s(t);
      else
        return e = t.lanes = 536870912, Kd(
          l,
          t,
          n !== null ? n.baseLanes | a : a,
          a,
          e
        );
    } else
      n !== null ? (an(t, n.cachePool), ws(t, n), ma(), t.memoizedState = null) : (l !== null && an(t, null), Pi(), ma());
    return Hl(l, t, u, a), t.child;
  }
  function su(l, t) {
    return l !== null && l.tag === 22 || t.stateNode !== null || (t.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), t.sibling;
  }
  function Kd(l, t, a, e, u) {
    var n = wi();
    return n = n === null ? null : { parent: El._currentValue, pool: n }, t.memoizedState = {
      baseLanes: a,
      cachePool: n
    }, l !== null && an(t, null), Pi(), $s(t), l !== null && re(l, t, e, !0), t.childLanes = u, null;
  }
  function bn(l, t) {
    return t = zn(
      { mode: t.mode, children: t.children },
      l.mode
    ), t.ref = l.ref, l.child = t, t.return = l, t;
  }
  function Jd(l, t, a) {
    return Xa(t, l.child, null, a), l = bn(t, t.pendingProps), l.flags |= 2, nt(t), t.memoizedState = null, l;
  }
  function mh(l, t, a) {
    var e = t.pendingProps, u = (t.flags & 128) !== 0;
    if (t.flags &= -129, l === null) {
      if (P) {
        if (e.mode === "hidden")
          return l = bn(t, e), t.lanes = 536870912, su(null, l);
        if (tc(t), (l = vl) ? (l = nm(
          l,
          St
        ), l = l !== null && l.data === "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ua !== null ? { id: Nt, overflow: Mt } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, a = Ns(l), a.return = t, t.child = a, Rl = t, vl = null)) : l = null, l === null) throw ia(t);
        return t.lanes = 536870912, null;
      }
      return bn(t, e);
    }
    var n = l.memoizedState;
    if (n !== null) {
      var i = n.dehydrated;
      if (tc(t), u)
        if (t.flags & 256)
          t.flags &= -257, t = Jd(
            l,
            t,
            a
          );
        else if (t.memoizedState !== null)
          t.child = l.child, t.flags |= 128, t = null;
        else throw Error(o(558));
      else if (_l || re(l, t, a, !1), u = (a & l.childLanes) !== 0, _l || u) {
        if (e = hl, e !== null && (i = qf(e, a), i !== 0 && i !== n.retryLane))
          throw n.retryLane = i, Ra(l, i), Fl(e, l, i), Ac;
        Mn(), t = Jd(
          l,
          t,
          a
        );
      } else
        l = n.treeContext, vl = pt(i.nextSibling), Rl = t, P = !0, na = null, St = !1, l !== null && Us(t, l), t = bn(t, e), t.flags |= 4096;
      return t;
    }
    return l = Bt(l.child, {
      mode: e.mode,
      children: e.children
    }), l.ref = t.ref, t.child = l, l.return = t, l;
  }
  function pn(l, t) {
    var a = t.ref;
    if (a === null)
      l !== null && l.ref !== null && (t.flags |= 4194816);
    else {
      if (typeof a != "function" && typeof a != "object")
        throw Error(o(284));
      (l === null || l.ref !== a) && (t.flags |= 4194816);
    }
  }
  function Tc(l, t, a, e, u) {
    return Ba(t), a = ec(
      l,
      t,
      a,
      e,
      void 0,
      u
    ), e = uc(), l !== null && !_l ? (nc(l, t, u), Zt(l, t, u)) : (P && e && Yi(t), t.flags |= 1, Hl(l, t, a, u), t.child);
  }
  function wd(l, t, a, e, u, n) {
    return Ba(t), t.updateQueue = null, a = ks(
      t,
      e,
      a,
      u
    ), Ws(l), e = uc(), l !== null && !_l ? (nc(l, t, n), Zt(l, t, n)) : (P && e && Yi(t), t.flags |= 1, Hl(l, t, a, n), t.child);
  }
  function $d(l, t, a, e, u) {
    if (Ba(t), t.stateNode === null) {
      var n = se, i = a.contextType;
      typeof i == "object" && i !== null && (n = Cl(i)), n = new a(e, n), t.memoizedState = n.state !== null && n.state !== void 0 ? n.state : null, n.updater = pc, t.stateNode = n, n._reactInternals = t, n = t.stateNode, n.props = e, n.state = t.memoizedState, n.refs = {}, Wi(t), i = a.contextType, n.context = typeof i == "object" && i !== null ? Cl(i) : se, n.state = t.memoizedState, i = a.getDerivedStateFromProps, typeof i == "function" && (bc(
        t,
        a,
        i,
        e
      ), n.state = t.memoizedState), typeof a.getDerivedStateFromProps == "function" || typeof n.getSnapshotBeforeUpdate == "function" || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (i = n.state, typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount(), i !== n.state && pc.enqueueReplaceState(n, n.state, null), uu(t, e, n, u), eu(), n.state = t.memoizedState), typeof n.componentDidMount == "function" && (t.flags |= 4194308), e = !0;
    } else if (l === null) {
      n = t.stateNode;
      var c = t.memoizedProps, s = Za(a, c);
      n.props = s;
      var y = n.context, p = a.contextType;
      i = se, typeof p == "object" && p !== null && (i = Cl(p));
      var j = a.getDerivedStateFromProps;
      p = typeof j == "function" || typeof n.getSnapshotBeforeUpdate == "function", c = t.pendingProps !== c, p || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (c || y !== i) && Cd(
        t,
        n,
        e,
        i
      ), fa = !1;
      var g = t.memoizedState;
      n.state = g, uu(t, e, n, u), eu(), y = t.memoizedState, c || g !== y || fa ? (typeof j == "function" && (bc(
        t,
        a,
        j,
        e
      ), y = t.memoizedState), (s = fa || Rd(
        t,
        a,
        s,
        e,
        g,
        y,
        i
      )) ? (p || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount()), typeof n.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = e, t.memoizedState = y), n.props = e, n.state = y, n.context = i, e = s) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), e = !1);
    } else {
      n = t.stateNode, ki(l, t), i = t.memoizedProps, p = Za(a, i), n.props = p, j = t.pendingProps, g = n.context, y = a.contextType, s = se, typeof y == "object" && y !== null && (s = Cl(y)), c = a.getDerivedStateFromProps, (y = typeof c == "function" || typeof n.getSnapshotBeforeUpdate == "function") || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (i !== j || g !== s) && Cd(
        t,
        n,
        e,
        s
      ), fa = !1, g = t.memoizedState, n.state = g, uu(t, e, n, u), eu();
      var S = t.memoizedState;
      i !== j || g !== S || fa || l !== null && l.dependencies !== null && ln(l.dependencies) ? (typeof c == "function" && (bc(
        t,
        a,
        c,
        e
      ), S = t.memoizedState), (p = fa || Rd(
        t,
        a,
        p,
        e,
        g,
        S,
        s
      ) || l !== null && l.dependencies !== null && ln(l.dependencies)) ? (y || typeof n.UNSAFE_componentWillUpdate != "function" && typeof n.componentWillUpdate != "function" || (typeof n.componentWillUpdate == "function" && n.componentWillUpdate(e, S, s), typeof n.UNSAFE_componentWillUpdate == "function" && n.UNSAFE_componentWillUpdate(
        e,
        S,
        s
      )), typeof n.componentDidUpdate == "function" && (t.flags |= 4), typeof n.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), t.memoizedProps = e, t.memoizedState = S), n.props = e, n.state = S, n.context = s, e = p) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), e = !1);
    }
    return n = e, pn(l, t), e = (t.flags & 128) !== 0, n || e ? (n = t.stateNode, a = e && typeof a.getDerivedStateFromError != "function" ? null : n.render(), t.flags |= 1, l !== null && e ? (t.child = Xa(
      t,
      l.child,
      null,
      u
    ), t.child = Xa(
      t,
      null,
      a,
      u
    )) : Hl(l, t, a, u), t.memoizedState = n.state, l = t.child) : l = Zt(
      l,
      t,
      u
    ), l;
  }
  function Wd(l, t, a, e) {
    return Ha(), t.flags |= 256, Hl(l, t, a, e), t.child;
  }
  var jc = {
    dehydrated: null,
    treeContext: null,
    retryLane: 0,
    hydrationErrors: null
  };
  function Ec(l) {
    return { baseLanes: l, cachePool: Ys() };
  }
  function xc(l, t, a) {
    return l = l !== null ? l.childLanes & ~a : 0, t && (l |= ct), l;
  }
  function kd(l, t, a) {
    var e = t.pendingProps, u = !1, n = (t.flags & 128) !== 0, i;
    if ((i = n) || (i = l !== null && l.memoizedState === null ? !1 : (Al.current & 2) !== 0), i && (u = !0, t.flags &= -129), i = (t.flags & 32) !== 0, t.flags &= -33, l === null) {
      if (P) {
        if (u ? oa(t) : ma(), (l = vl) ? (l = nm(
          l,
          St
        ), l = l !== null && l.data !== "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ua !== null ? { id: Nt, overflow: Mt } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, a = Ns(l), a.return = t, t.child = a, Rl = t, vl = null)) : l = null, l === null) throw ia(t);
        return sf(l) ? t.lanes = 32 : t.lanes = 536870912, null;
      }
      var c = e.children;
      return e = e.fallback, u ? (ma(), u = t.mode, c = zn(
        { mode: "hidden", children: c },
        u
      ), e = Ca(
        e,
        u,
        a,
        null
      ), c.return = t, e.return = t, c.sibling = e, t.child = c, e = t.child, e.memoizedState = Ec(a), e.childLanes = xc(
        l,
        i,
        a
      ), t.memoizedState = jc, su(null, e)) : (oa(t), _c(t, c));
    }
    var s = l.memoizedState;
    if (s !== null && (c = s.dehydrated, c !== null)) {
      if (n)
        t.flags & 256 ? (oa(t), t.flags &= -257, t = Oc(
          l,
          t,
          a
        )) : t.memoizedState !== null ? (ma(), t.child = l.child, t.flags |= 128, t = null) : (ma(), c = e.fallback, u = t.mode, e = zn(
          { mode: "visible", children: e.children },
          u
        ), c = Ca(
          c,
          u,
          a,
          null
        ), c.flags |= 2, e.return = t, c.return = t, e.sibling = c, t.child = e, Xa(
          t,
          l.child,
          null,
          a
        ), e = t.child, e.memoizedState = Ec(a), e.childLanes = xc(
          l,
          i,
          a
        ), t.memoizedState = jc, t = su(null, e));
      else if (oa(t), sf(c)) {
        if (i = c.nextSibling && c.nextSibling.dataset, i) var y = i.dgst;
        i = y, e = Error(o(419)), e.stack = "", e.digest = i, Fe({ value: e, source: null, stack: null }), t = Oc(
          l,
          t,
          a
        );
      } else if (_l || re(l, t, a, !1), i = (a & l.childLanes) !== 0, _l || i) {
        if (i = hl, i !== null && (e = qf(i, a), e !== 0 && e !== s.retryLane))
          throw s.retryLane = e, Ra(l, e), Fl(i, l, e), Ac;
        ff(c) || Mn(), t = Oc(
          l,
          t,
          a
        );
      } else
        ff(c) ? (t.flags |= 192, t.child = l.child, t = null) : (l = s.treeContext, vl = pt(
          c.nextSibling
        ), Rl = t, P = !0, na = null, St = !1, l !== null && Us(t, l), t = _c(
          t,
          e.children
        ), t.flags |= 4096);
      return t;
    }
    return u ? (ma(), c = e.fallback, u = t.mode, s = l.child, y = s.sibling, e = Bt(s, {
      mode: "hidden",
      children: e.children
    }), e.subtreeFlags = s.subtreeFlags & 65011712, y !== null ? c = Bt(
      y,
      c
    ) : (c = Ca(
      c,
      u,
      a,
      null
    ), c.flags |= 2), c.return = t, e.return = t, e.sibling = c, t.child = e, su(null, e), e = t.child, c = l.child.memoizedState, c === null ? c = Ec(a) : (u = c.cachePool, u !== null ? (s = El._currentValue, u = u.parent !== s ? { parent: s, pool: s } : u) : u = Ys(), c = {
      baseLanes: c.baseLanes | a,
      cachePool: u
    }), e.memoizedState = c, e.childLanes = xc(
      l,
      i,
      a
    ), t.memoizedState = jc, su(l.child, e)) : (oa(t), a = l.child, l = a.sibling, a = Bt(a, {
      mode: "visible",
      children: e.children
    }), a.return = t, a.sibling = null, l !== null && (i = t.deletions, i === null ? (t.deletions = [l], t.flags |= 16) : i.push(l)), t.child = a, t.memoizedState = null, a);
  }
  function _c(l, t) {
    return t = zn(
      { mode: "visible", children: t },
      l.mode
    ), t.return = l, l.child = t;
  }
  function zn(l, t) {
    return l = et(22, l, null, t), l.lanes = 0, l;
  }
  function Oc(l, t, a) {
    return Xa(t, l.child, null, a), l = _c(
      t,
      t.pendingProps.children
    ), l.flags |= 2, t.memoizedState = null, l;
  }
  function Fd(l, t, a) {
    l.lanes |= t;
    var e = l.alternate;
    e !== null && (e.lanes |= t), Zi(l.return, t, a);
  }
  function Nc(l, t, a, e, u, n) {
    var i = l.memoizedState;
    i === null ? l.memoizedState = {
      isBackwards: t,
      rendering: null,
      renderingStartTime: 0,
      last: e,
      tail: a,
      tailMode: u,
      treeForkCount: n
    } : (i.isBackwards = t, i.rendering = null, i.renderingStartTime = 0, i.last = e, i.tail = a, i.tailMode = u, i.treeForkCount = n);
  }
  function Id(l, t, a) {
    var e = t.pendingProps, u = e.revealOrder, n = e.tail;
    e = e.children;
    var i = Al.current, c = (i & 2) !== 0;
    if (c ? (i = i & 1 | 2, t.flags |= 128) : i &= 1, U(Al, i), Hl(l, t, e, a), e = P ? ke : 0, !c && l !== null && (l.flags & 128) !== 0)
      l: for (l = t.child; l !== null; ) {
        if (l.tag === 13)
          l.memoizedState !== null && Fd(l, a, t);
        else if (l.tag === 19)
          Fd(l, a, t);
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
        for (a = t.child, u = null; a !== null; )
          l = a.alternate, l !== null && sn(l) === null && (u = a), a = a.sibling;
        a = u, a === null ? (u = t.child, t.child = null) : (u = a.sibling, a.sibling = null), Nc(
          t,
          !1,
          u,
          a,
          n,
          e
        );
        break;
      case "backwards":
      case "unstable_legacy-backwards":
        for (a = null, u = t.child, t.child = null; u !== null; ) {
          if (l = u.alternate, l !== null && sn(l) === null) {
            t.child = u;
            break;
          }
          l = u.sibling, u.sibling = a, a = u, u = l;
        }
        Nc(
          t,
          !0,
          a,
          null,
          n,
          e
        );
        break;
      case "together":
        Nc(
          t,
          !1,
          null,
          null,
          void 0,
          e
        );
        break;
      default:
        t.memoizedState = null;
    }
    return t.child;
  }
  function Zt(l, t, a) {
    if (l !== null && (t.dependencies = l.dependencies), va |= t.lanes, (a & t.childLanes) === 0)
      if (l !== null) {
        if (re(
          l,
          t,
          a,
          !1
        ), (a & t.childLanes) === 0)
          return null;
      } else return null;
    if (l !== null && t.child !== l.child)
      throw Error(o(153));
    if (t.child !== null) {
      for (l = t.child, a = Bt(l, l.pendingProps), t.child = a, a.return = t; l.sibling !== null; )
        l = l.sibling, a = a.sibling = Bt(l, l.pendingProps), a.return = t;
      a.sibling = null;
    }
    return t.child;
  }
  function Mc(l, t) {
    return (l.lanes & t) !== 0 ? !0 : (l = l.dependencies, !!(l !== null && ln(l)));
  }
  function rh(l, t, a) {
    switch (t.tag) {
      case 3:
        Gl(t, t.stateNode.containerInfo), ca(t, El, l.memoizedState.cache), Ha();
        break;
      case 27:
      case 5:
        He(t);
        break;
      case 4:
        Gl(t, t.stateNode.containerInfo);
        break;
      case 10:
        ca(
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
        var e = t.memoizedState;
        if (e !== null)
          return e.dehydrated !== null ? (oa(t), t.flags |= 128, null) : (a & t.child.childLanes) !== 0 ? kd(l, t, a) : (oa(t), l = Zt(
            l,
            t,
            a
          ), l !== null ? l.sibling : null);
        oa(t);
        break;
      case 19:
        var u = (l.flags & 128) !== 0;
        if (e = (a & t.childLanes) !== 0, e || (re(
          l,
          t,
          a,
          !1
        ), e = (a & t.childLanes) !== 0), u) {
          if (e)
            return Id(
              l,
              t,
              a
            );
          t.flags |= 128;
        }
        if (u = t.memoizedState, u !== null && (u.rendering = null, u.tail = null, u.lastEffect = null), U(Al, Al.current), e) break;
        return null;
      case 22:
        return t.lanes = 0, Vd(
          l,
          t,
          a,
          t.pendingProps
        );
      case 24:
        ca(t, El, l.memoizedState.cache);
    }
    return Zt(l, t, a);
  }
  function Pd(l, t, a) {
    if (l !== null)
      if (l.memoizedProps !== t.pendingProps)
        _l = !0;
      else {
        if (!Mc(l, a) && (t.flags & 128) === 0)
          return _l = !1, rh(
            l,
            t,
            a
          );
        _l = (l.flags & 131072) !== 0;
      }
    else
      _l = !1, P && (t.flags & 1048576) !== 0 && Ds(t, ke, t.index);
    switch (t.lanes = 0, t.tag) {
      case 16:
        l: {
          var e = t.pendingProps;
          if (l = Ga(t.elementType), t.type = l, typeof l == "function")
            Hi(l) ? (e = Za(l, e), t.tag = 1, t = $d(
              null,
              t,
              l,
              e,
              a
            )) : (t.tag = 0, t = Tc(
              null,
              t,
              l,
              e,
              a
            ));
          else {
            if (l != null) {
              var u = l.$$typeof;
              if (u === ot) {
                t.tag = 11, t = Xd(
                  null,
                  t,
                  l,
                  e,
                  a
                );
                break l;
              } else if (u === I) {
                t.tag = 14, t = Ld(
                  null,
                  t,
                  l,
                  e,
                  a
                );
                break l;
              }
            }
            throw t = Rt(l) || l, Error(o(306, t, ""));
          }
        }
        return t;
      case 0:
        return Tc(
          l,
          t,
          t.type,
          t.pendingProps,
          a
        );
      case 1:
        return e = t.type, u = Za(
          e,
          t.pendingProps
        ), $d(
          l,
          t,
          e,
          u,
          a
        );
      case 3:
        l: {
          if (Gl(
            t,
            t.stateNode.containerInfo
          ), l === null) throw Error(o(387));
          e = t.pendingProps;
          var n = t.memoizedState;
          u = n.element, ki(l, t), uu(t, e, null, a);
          var i = t.memoizedState;
          if (e = i.cache, ca(t, El, e), e !== n.cache && Vi(
            t,
            [El],
            a,
            !0
          ), eu(), e = i.element, n.isDehydrated)
            if (n = {
              element: e,
              isDehydrated: !1,
              cache: i.cache
            }, t.updateQueue.baseState = n, t.memoizedState = n, t.flags & 256) {
              t = Wd(
                l,
                t,
                e,
                a
              );
              break l;
            } else if (e !== u) {
              u = vt(
                Error(o(424)),
                t
              ), Fe(u), t = Wd(
                l,
                t,
                e,
                a
              );
              break l;
            } else
              for (l = t.stateNode.containerInfo, l.nodeType === 9 ? l = l.body : l = l.nodeName === "HTML" ? l.ownerDocument.body : l, vl = pt(l.firstChild), Rl = t, P = !0, na = null, St = !0, a = Vs(
                t,
                null,
                e,
                a
              ), t.child = a; a; )
                a.flags = a.flags & -3 | 4096, a = a.sibling;
          else {
            if (Ha(), e === u) {
              t = Zt(
                l,
                t,
                a
              );
              break l;
            }
            Hl(l, t, e, a);
          }
          t = t.child;
        }
        return t;
      case 26:
        return pn(l, t), l === null ? (a = om(
          t.type,
          null,
          t.pendingProps,
          null
        )) ? t.memoizedState = a : P || (a = t.type, l = t.pendingProps, e = Bn(
          w.current
        ).createElement(a), e[Ul] = t, e[Kl] = l, ql(e, a, l), Ml(e), t.stateNode = e) : t.memoizedState = om(
          t.type,
          l.memoizedProps,
          t.pendingProps,
          l.memoizedState
        ), null;
      case 27:
        return He(t), l === null && P && (e = t.stateNode = fm(
          t.type,
          t.pendingProps,
          w.current
        ), Rl = t, St = !0, u = vl, pa(t.type) ? (df = u, vl = pt(e.firstChild)) : vl = u), Hl(
          l,
          t,
          t.pendingProps.children,
          a
        ), pn(l, t), l === null && (t.flags |= 4194304), t.child;
      case 5:
        return l === null && P && ((u = e = vl) && (e = Zh(
          e,
          t.type,
          t.pendingProps,
          St
        ), e !== null ? (t.stateNode = e, Rl = t, vl = pt(e.firstChild), St = !1, u = !0) : u = !1), u || ia(t)), He(t), u = t.type, n = t.pendingProps, i = l !== null ? l.memoizedProps : null, e = n.children, uf(u, n) ? e = null : i !== null && uf(u, i) && (t.flags |= 32), t.memoizedState !== null && (u = ec(
          l,
          t,
          uh,
          null,
          null,
          a
        ), ju._currentValue = u), pn(l, t), Hl(l, t, e, a), t.child;
      case 6:
        return l === null && P && ((l = a = vl) && (a = Vh(
          a,
          t.pendingProps,
          St
        ), a !== null ? (t.stateNode = a, Rl = t, vl = null, l = !0) : l = !1), l || ia(t)), null;
      case 13:
        return kd(l, t, a);
      case 4:
        return Gl(
          t,
          t.stateNode.containerInfo
        ), e = t.pendingProps, l === null ? t.child = Xa(
          t,
          null,
          e,
          a
        ) : Hl(l, t, e, a), t.child;
      case 11:
        return Xd(
          l,
          t,
          t.type,
          t.pendingProps,
          a
        );
      case 7:
        return Hl(
          l,
          t,
          t.pendingProps,
          a
        ), t.child;
      case 8:
        return Hl(
          l,
          t,
          t.pendingProps.children,
          a
        ), t.child;
      case 12:
        return Hl(
          l,
          t,
          t.pendingProps.children,
          a
        ), t.child;
      case 10:
        return e = t.pendingProps, ca(t, t.type, e.value), Hl(l, t, e.children, a), t.child;
      case 9:
        return u = t.type._context, e = t.pendingProps.children, Ba(t), u = Cl(u), e = e(u), t.flags |= 1, Hl(l, t, e, a), t.child;
      case 14:
        return Ld(
          l,
          t,
          t.type,
          t.pendingProps,
          a
        );
      case 15:
        return Zd(
          l,
          t,
          t.type,
          t.pendingProps,
          a
        );
      case 19:
        return Id(l, t, a);
      case 31:
        return mh(l, t, a);
      case 22:
        return Vd(
          l,
          t,
          a,
          t.pendingProps
        );
      case 24:
        return Ba(t), e = Cl(El), l === null ? (u = wi(), u === null && (u = hl, n = Ki(), u.pooledCache = n, n.refCount++, n !== null && (u.pooledCacheLanes |= a), u = n), t.memoizedState = { parent: e, cache: u }, Wi(t), ca(t, El, u)) : ((l.lanes & a) !== 0 && (ki(l, t), uu(t, null, null, a), eu()), u = l.memoizedState, n = t.memoizedState, u.parent !== e ? (u = { parent: e, cache: e }, t.memoizedState = u, t.lanes === 0 && (t.memoizedState = t.updateQueue.baseState = u), ca(t, El, e)) : (e = n.cache, ca(t, El, e), e !== u.cache && Vi(
          t,
          [El],
          a,
          !0
        ))), Hl(
          l,
          t,
          t.pendingProps.children,
          a
        ), t.child;
      case 29:
        throw t.pendingProps;
    }
    throw Error(o(156, t.tag));
  }
  function Vt(l) {
    l.flags |= 4;
  }
  function Dc(l, t, a, e, u) {
    if ((t = (l.mode & 32) !== 0) && (t = !1), t) {
      if (l.flags |= 16777216, (u & 335544128) === u)
        if (l.stateNode.complete) l.flags |= 8192;
        else if (_o()) l.flags |= 8192;
        else
          throw Qa = un, $i;
    } else l.flags &= -16777217;
  }
  function lo(l, t) {
    if (t.type !== "stylesheet" || (t.state.loading & 4) !== 0)
      l.flags &= -16777217;
    else if (l.flags |= 16777216, !ym(t))
      if (_o()) l.flags |= 8192;
      else
        throw Qa = un, $i;
  }
  function An(l, t) {
    t !== null && (l.flags |= 4), l.flags & 16384 && (t = l.tag !== 22 ? Rf() : 536870912, l.lanes |= t, Ee |= t);
  }
  function du(l, t) {
    if (!P)
      switch (l.tailMode) {
        case "hidden":
          t = l.tail;
          for (var a = null; t !== null; )
            t.alternate !== null && (a = t), t = t.sibling;
          a === null ? l.tail = null : a.sibling = null;
          break;
        case "collapsed":
          a = l.tail;
          for (var e = null; a !== null; )
            a.alternate !== null && (e = a), a = a.sibling;
          e === null ? t || l.tail === null ? l.tail = null : l.tail.sibling = null : e.sibling = null;
      }
  }
  function yl(l) {
    var t = l.alternate !== null && l.alternate.child === l.child, a = 0, e = 0;
    if (t)
      for (var u = l.child; u !== null; )
        a |= u.lanes | u.childLanes, e |= u.subtreeFlags & 65011712, e |= u.flags & 65011712, u.return = l, u = u.sibling;
    else
      for (u = l.child; u !== null; )
        a |= u.lanes | u.childLanes, e |= u.subtreeFlags, e |= u.flags, u.return = l, u = u.sibling;
    return l.subtreeFlags |= e, l.childLanes = a, t;
  }
  function hh(l, t, a) {
    var e = t.pendingProps;
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
        return yl(t), null;
      case 1:
        return yl(t), null;
      case 3:
        return a = t.stateNode, e = null, l !== null && (e = l.memoizedState.cache), t.memoizedState.cache !== e && (t.flags |= 2048), Qt(El), zl(), a.pendingContext && (a.context = a.pendingContext, a.pendingContext = null), (l === null || l.child === null) && (me(t) ? Vt(t) : l === null || l.memoizedState.isDehydrated && (t.flags & 256) === 0 || (t.flags |= 1024, Xi())), yl(t), null;
      case 26:
        var u = t.type, n = t.memoizedState;
        return l === null ? (Vt(t), n !== null ? (yl(t), lo(t, n)) : (yl(t), Dc(
          t,
          u,
          null,
          e,
          a
        ))) : n ? n !== l.memoizedState ? (Vt(t), yl(t), lo(t, n)) : (yl(t), t.flags &= -16777217) : (l = l.memoizedProps, l !== e && Vt(t), yl(t), Dc(
          t,
          u,
          l,
          e,
          a
        )), null;
      case 27:
        if (Uu(t), a = w.current, u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== e && Vt(t);
        else {
          if (!e) {
            if (t.stateNode === null)
              throw Error(o(166));
            return yl(t), null;
          }
          l = q.current, me(t) ? Rs(t) : (l = fm(u, e, a), t.stateNode = l, Vt(t));
        }
        return yl(t), null;
      case 5:
        if (Uu(t), u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== e && Vt(t);
        else {
          if (!e) {
            if (t.stateNode === null)
              throw Error(o(166));
            return yl(t), null;
          }
          if (n = q.current, me(t))
            Rs(t);
          else {
            var i = Bn(
              w.current
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
                    n = typeof e.is == "string" ? i.createElement("select", {
                      is: e.is
                    }) : i.createElement("select"), e.multiple ? n.multiple = !0 : e.size && (n.size = e.size);
                    break;
                  default:
                    n = typeof e.is == "string" ? i.createElement(u, { is: e.is }) : i.createElement(u);
                }
            }
            n[Ul] = t, n[Kl] = e;
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
            l: switch (ql(n, u, e), u) {
              case "button":
              case "input":
              case "select":
              case "textarea":
                e = !!e.autoFocus;
                break l;
              case "img":
                e = !0;
                break l;
              default:
                e = !1;
            }
            e && Vt(t);
          }
        }
        return yl(t), Dc(
          t,
          t.type,
          l === null ? null : l.memoizedProps,
          t.pendingProps,
          a
        ), null;
      case 6:
        if (l && t.stateNode != null)
          l.memoizedProps !== e && Vt(t);
        else {
          if (typeof e != "string" && t.stateNode === null)
            throw Error(o(166));
          if (l = w.current, me(t)) {
            if (l = t.stateNode, a = t.memoizedProps, e = null, u = Rl, u !== null)
              switch (u.tag) {
                case 27:
                case 5:
                  e = u.memoizedProps;
              }
            l[Ul] = t, l = !!(l.nodeValue === a || e !== null && e.suppressHydrationWarning === !0 || Fo(l.nodeValue, a)), l || ia(t, !0);
          } else
            l = Bn(l).createTextNode(
              e
            ), l[Ul] = t, t.stateNode = l;
        }
        return yl(t), null;
      case 31:
        if (a = t.memoizedState, l === null || l.memoizedState !== null) {
          if (e = me(t), a !== null) {
            if (l === null) {
              if (!e) throw Error(o(318));
              if (l = t.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(557));
              l[Ul] = t;
            } else
              Ha(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            yl(t), l = !1;
          } else
            a = Xi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = a), l = !0;
          if (!l)
            return t.flags & 256 ? (nt(t), t) : (nt(t), null);
          if ((t.flags & 128) !== 0)
            throw Error(o(558));
        }
        return yl(t), null;
      case 13:
        if (e = t.memoizedState, l === null || l.memoizedState !== null && l.memoizedState.dehydrated !== null) {
          if (u = me(t), e !== null && e.dehydrated !== null) {
            if (l === null) {
              if (!u) throw Error(o(318));
              if (u = t.memoizedState, u = u !== null ? u.dehydrated : null, !u) throw Error(o(317));
              u[Ul] = t;
            } else
              Ha(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            yl(t), u = !1;
          } else
            u = Xi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = u), u = !0;
          if (!u)
            return t.flags & 256 ? (nt(t), t) : (nt(t), null);
        }
        return nt(t), (t.flags & 128) !== 0 ? (t.lanes = a, t) : (a = e !== null, l = l !== null && l.memoizedState !== null, a && (e = t.child, u = null, e.alternate !== null && e.alternate.memoizedState !== null && e.alternate.memoizedState.cachePool !== null && (u = e.alternate.memoizedState.cachePool.pool), n = null, e.memoizedState !== null && e.memoizedState.cachePool !== null && (n = e.memoizedState.cachePool.pool), n !== u && (e.flags |= 2048)), a !== l && a && (t.child.flags |= 8192), An(t, t.updateQueue), yl(t), null);
      case 4:
        return zl(), l === null && Pc(t.stateNode.containerInfo), yl(t), null;
      case 10:
        return Qt(t.type), yl(t), null;
      case 19:
        if (E(Al), e = t.memoizedState, e === null) return yl(t), null;
        if (u = (t.flags & 128) !== 0, n = e.rendering, n === null)
          if (u) du(e, !1);
          else {
            if (pl !== 0 || l !== null && (l.flags & 128) !== 0)
              for (l = t.child; l !== null; ) {
                if (n = sn(l), n !== null) {
                  for (t.flags |= 128, du(e, !1), l = n.updateQueue, t.updateQueue = l, An(t, l), t.subtreeFlags = 0, l = a, a = t.child; a !== null; )
                    Os(a, l), a = a.sibling;
                  return U(
                    Al,
                    Al.current & 1 | 2
                  ), P && Yt(t, e.treeForkCount), t.child;
                }
                l = l.sibling;
              }
            e.tail !== null && Pl() > _n && (t.flags |= 128, u = !0, du(e, !1), t.lanes = 4194304);
          }
        else {
          if (!u)
            if (l = sn(n), l !== null) {
              if (t.flags |= 128, u = !0, l = l.updateQueue, t.updateQueue = l, An(t, l), du(e, !0), e.tail === null && e.tailMode === "hidden" && !n.alternate && !P)
                return yl(t), null;
            } else
              2 * Pl() - e.renderingStartTime > _n && a !== 536870912 && (t.flags |= 128, u = !0, du(e, !1), t.lanes = 4194304);
          e.isBackwards ? (n.sibling = t.child, t.child = n) : (l = e.last, l !== null ? l.sibling = n : t.child = n, e.last = n);
        }
        return e.tail !== null ? (l = e.tail, e.rendering = l, e.tail = l.sibling, e.renderingStartTime = Pl(), l.sibling = null, a = Al.current, U(
          Al,
          u ? a & 1 | 2 : a & 1
        ), P && Yt(t, e.treeForkCount), l) : (yl(t), null);
      case 22:
      case 23:
        return nt(t), lc(), e = t.memoizedState !== null, l !== null ? l.memoizedState !== null !== e && (t.flags |= 8192) : e && (t.flags |= 8192), e ? (a & 536870912) !== 0 && (t.flags & 128) === 0 && (yl(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : yl(t), a = t.updateQueue, a !== null && An(t, a.retryQueue), a = null, l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (a = l.memoizedState.cachePool.pool), e = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (e = t.memoizedState.cachePool.pool), e !== a && (t.flags |= 2048), l !== null && E(Ya), null;
      case 24:
        return a = null, l !== null && (a = l.memoizedState.cache), t.memoizedState.cache !== a && (t.flags |= 2048), Qt(El), yl(t), null;
      case 25:
        return null;
      case 30:
        return null;
    }
    throw Error(o(156, t.tag));
  }
  function vh(l, t) {
    switch (Gi(t), t.tag) {
      case 1:
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 3:
        return Qt(El), zl(), l = t.flags, (l & 65536) !== 0 && (l & 128) === 0 ? (t.flags = l & -65537 | 128, t) : null;
      case 26:
      case 27:
      case 5:
        return Uu(t), null;
      case 31:
        if (t.memoizedState !== null) {
          if (nt(t), t.alternate === null)
            throw Error(o(340));
          Ha();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 13:
        if (nt(t), l = t.memoizedState, l !== null && l.dehydrated !== null) {
          if (t.alternate === null)
            throw Error(o(340));
          Ha();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 19:
        return E(Al), null;
      case 4:
        return zl(), null;
      case 10:
        return Qt(t.type), null;
      case 22:
      case 23:
        return nt(t), lc(), l !== null && E(Ya), l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 24:
        return Qt(El), null;
      case 25:
        return null;
      default:
        return null;
    }
  }
  function to(l, t) {
    switch (Gi(t), t.tag) {
      case 3:
        Qt(El), zl();
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
        t.memoizedState !== null && nt(t);
        break;
      case 13:
        nt(t);
        break;
      case 19:
        E(Al);
        break;
      case 10:
        Qt(t.type);
        break;
      case 22:
      case 23:
        nt(t), lc(), l !== null && E(Ya);
        break;
      case 24:
        Qt(El);
    }
  }
  function ou(l, t) {
    try {
      var a = t.updateQueue, e = a !== null ? a.lastEffect : null;
      if (e !== null) {
        var u = e.next;
        a = u;
        do {
          if ((a.tag & l) === l) {
            e = void 0;
            var n = a.create, i = a.inst;
            e = n(), i.destroy = e;
          }
          a = a.next;
        } while (a !== u);
      }
    } catch (c) {
      fl(t, t.return, c);
    }
  }
  function ra(l, t, a) {
    try {
      var e = t.updateQueue, u = e !== null ? e.lastEffect : null;
      if (u !== null) {
        var n = u.next;
        e = n;
        do {
          if ((e.tag & l) === l) {
            var i = e.inst, c = i.destroy;
            if (c !== void 0) {
              i.destroy = void 0, u = t;
              var s = a, y = c;
              try {
                y();
              } catch (p) {
                fl(
                  u,
                  s,
                  p
                );
              }
            }
          }
          e = e.next;
        } while (e !== n);
      }
    } catch (p) {
      fl(t, t.return, p);
    }
  }
  function ao(l) {
    var t = l.updateQueue;
    if (t !== null) {
      var a = l.stateNode;
      try {
        Js(t, a);
      } catch (e) {
        fl(l, l.return, e);
      }
    }
  }
  function eo(l, t, a) {
    a.props = Za(
      l.type,
      l.memoizedProps
    ), a.state = l.memoizedState;
    try {
      a.componentWillUnmount();
    } catch (e) {
      fl(l, t, e);
    }
  }
  function mu(l, t) {
    try {
      var a = l.ref;
      if (a !== null) {
        switch (l.tag) {
          case 26:
          case 27:
          case 5:
            var e = l.stateNode;
            break;
          case 30:
            e = l.stateNode;
            break;
          default:
            e = l.stateNode;
        }
        typeof a == "function" ? l.refCleanup = a(e) : a.current = e;
      }
    } catch (u) {
      fl(l, t, u);
    }
  }
  function Dt(l, t) {
    var a = l.ref, e = l.refCleanup;
    if (a !== null)
      if (typeof e == "function")
        try {
          e();
        } catch (u) {
          fl(l, t, u);
        } finally {
          l.refCleanup = null, l = l.alternate, l != null && (l.refCleanup = null);
        }
      else if (typeof a == "function")
        try {
          a(null);
        } catch (u) {
          fl(l, t, u);
        }
      else a.current = null;
  }
  function uo(l) {
    var t = l.type, a = l.memoizedProps, e = l.stateNode;
    try {
      l: switch (t) {
        case "button":
        case "input":
        case "select":
        case "textarea":
          a.autoFocus && e.focus();
          break l;
        case "img":
          a.src ? e.src = a.src : a.srcSet && (e.srcset = a.srcSet);
      }
    } catch (u) {
      fl(l, l.return, u);
    }
  }
  function Uc(l, t, a) {
    try {
      var e = l.stateNode;
      Bh(e, l.type, a, t), e[Kl] = t;
    } catch (u) {
      fl(l, l.return, u);
    }
  }
  function no(l) {
    return l.tag === 5 || l.tag === 3 || l.tag === 26 || l.tag === 27 && pa(l.type) || l.tag === 4;
  }
  function Rc(l) {
    l: for (; ; ) {
      for (; l.sibling === null; ) {
        if (l.return === null || no(l.return)) return null;
        l = l.return;
      }
      for (l.sibling.return = l.return, l = l.sibling; l.tag !== 5 && l.tag !== 6 && l.tag !== 18; ) {
        if (l.tag === 27 && pa(l.type) || l.flags & 2 || l.child === null || l.tag === 4) continue l;
        l.child.return = l, l = l.child;
      }
      if (!(l.flags & 2)) return l.stateNode;
    }
  }
  function Cc(l, t, a) {
    var e = l.tag;
    if (e === 5 || e === 6)
      l = l.stateNode, t ? (a.nodeType === 9 ? a.body : a.nodeName === "HTML" ? a.ownerDocument.body : a).insertBefore(l, t) : (t = a.nodeType === 9 ? a.body : a.nodeName === "HTML" ? a.ownerDocument.body : a, t.appendChild(l), a = a._reactRootContainer, a != null || t.onclick !== null || (t.onclick = Ht));
    else if (e !== 4 && (e === 27 && pa(l.type) && (a = l.stateNode, t = null), l = l.child, l !== null))
      for (Cc(l, t, a), l = l.sibling; l !== null; )
        Cc(l, t, a), l = l.sibling;
  }
  function Tn(l, t, a) {
    var e = l.tag;
    if (e === 5 || e === 6)
      l = l.stateNode, t ? a.insertBefore(l, t) : a.appendChild(l);
    else if (e !== 4 && (e === 27 && pa(l.type) && (a = l.stateNode), l = l.child, l !== null))
      for (Tn(l, t, a), l = l.sibling; l !== null; )
        Tn(l, t, a), l = l.sibling;
  }
  function io(l) {
    var t = l.stateNode, a = l.memoizedProps;
    try {
      for (var e = l.type, u = t.attributes; u.length; )
        t.removeAttributeNode(u[0]);
      ql(t, e, a), t[Ul] = l, t[Kl] = a;
    } catch (n) {
      fl(l, l.return, n);
    }
  }
  var Kt = !1, Ol = !1, Hc = !1, co = typeof WeakSet == "function" ? WeakSet : Set, Dl = null;
  function yh(l, t) {
    if (l = l.containerInfo, af = Vn, l = bs(l), Oi(l)) {
      if ("selectionStart" in l)
        var a = {
          start: l.selectionStart,
          end: l.selectionEnd
        };
      else
        l: {
          a = (a = l.ownerDocument) && a.defaultView || window;
          var e = a.getSelection && a.getSelection();
          if (e && e.rangeCount !== 0) {
            a = e.anchorNode;
            var u = e.anchorOffset, n = e.focusNode;
            e = e.focusOffset;
            try {
              a.nodeType, n.nodeType;
            } catch {
              a = null;
              break l;
            }
            var i = 0, c = -1, s = -1, y = 0, p = 0, j = l, g = null;
            t: for (; ; ) {
              for (var S; j !== a || u !== 0 && j.nodeType !== 3 || (c = i + u), j !== n || e !== 0 && j.nodeType !== 3 || (s = i + e), j.nodeType === 3 && (i += j.nodeValue.length), (S = j.firstChild) !== null; )
                g = j, j = S;
              for (; ; ) {
                if (j === l) break t;
                if (g === a && ++y === u && (c = i), g === n && ++p === e && (s = i), (S = j.nextSibling) !== null) break;
                j = g, g = j.parentNode;
              }
              j = S;
            }
            a = c === -1 || s === -1 ? null : { start: c, end: s };
          } else a = null;
        }
      a = a || { start: 0, end: 0 };
    } else a = null;
    for (ef = { focusedElem: l, selectionRange: a }, Vn = !1, Dl = t; Dl !== null; )
      if (t = Dl, l = t.child, (t.subtreeFlags & 1028) !== 0 && l !== null)
        l.return = t, Dl = l;
      else
        for (; Dl !== null; ) {
          switch (t = Dl, n = t.alternate, l = t.flags, t.tag) {
            case 0:
              if ((l & 4) !== 0 && (l = t.updateQueue, l = l !== null ? l.events : null, l !== null))
                for (a = 0; a < l.length; a++)
                  u = l[a], u.ref.impl = u.nextImpl;
              break;
            case 11:
            case 15:
              break;
            case 1:
              if ((l & 1024) !== 0 && n !== null) {
                l = void 0, a = t, u = n.memoizedProps, n = n.memoizedState, e = a.stateNode;
                try {
                  var R = Za(
                    a.type,
                    u
                  );
                  l = e.getSnapshotBeforeUpdate(
                    R,
                    n
                  ), e.__reactInternalSnapshotBeforeUpdate = l;
                } catch (G) {
                  fl(
                    a,
                    a.return,
                    G
                  );
                }
              }
              break;
            case 3:
              if ((l & 1024) !== 0) {
                if (l = t.stateNode.containerInfo, a = l.nodeType, a === 9)
                  cf(l);
                else if (a === 1)
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
              if ((l & 1024) !== 0) throw Error(o(163));
          }
          if (l = t.sibling, l !== null) {
            l.return = t.return, Dl = l;
            break;
          }
          Dl = t.return;
        }
  }
  function fo(l, t, a) {
    var e = a.flags;
    switch (a.tag) {
      case 0:
      case 11:
      case 15:
        wt(l, a), e & 4 && ou(5, a);
        break;
      case 1:
        if (wt(l, a), e & 4)
          if (l = a.stateNode, t === null)
            try {
              l.componentDidMount();
            } catch (i) {
              fl(a, a.return, i);
            }
          else {
            var u = Za(
              a.type,
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
                a,
                a.return,
                i
              );
            }
          }
        e & 64 && ao(a), e & 512 && mu(a, a.return);
        break;
      case 3:
        if (wt(l, a), e & 64 && (l = a.updateQueue, l !== null)) {
          if (t = null, a.child !== null)
            switch (a.child.tag) {
              case 27:
              case 5:
                t = a.child.stateNode;
                break;
              case 1:
                t = a.child.stateNode;
            }
          try {
            Js(l, t);
          } catch (i) {
            fl(a, a.return, i);
          }
        }
        break;
      case 27:
        t === null && e & 4 && io(a);
      case 26:
      case 5:
        wt(l, a), t === null && e & 4 && uo(a), e & 512 && mu(a, a.return);
        break;
      case 12:
        wt(l, a);
        break;
      case 31:
        wt(l, a), e & 4 && mo(l, a);
        break;
      case 13:
        wt(l, a), e & 4 && ro(l, a), e & 64 && (l = a.memoizedState, l !== null && (l = l.dehydrated, l !== null && (a = Eh.bind(
          null,
          a
        ), Kh(l, a))));
        break;
      case 22:
        if (e = a.memoizedState !== null || Kt, !e) {
          t = t !== null && t.memoizedState !== null || Ol, u = Kt;
          var n = Ol;
          Kt = e, (Ol = t) && !n ? $t(
            l,
            a,
            (a.subtreeFlags & 8772) !== 0
          ) : wt(l, a), Kt = u, Ol = n;
        }
        break;
      case 30:
        break;
      default:
        wt(l, a);
    }
  }
  function so(l) {
    var t = l.alternate;
    t !== null && (l.alternate = null, so(t)), l.child = null, l.deletions = null, l.sibling = null, l.tag === 5 && (t = l.stateNode, t !== null && oi(t)), l.stateNode = null, l.return = null, l.dependencies = null, l.memoizedProps = null, l.memoizedState = null, l.pendingProps = null, l.stateNode = null, l.updateQueue = null;
  }
  var gl = null, wl = !1;
  function Jt(l, t, a) {
    for (a = a.child; a !== null; )
      oo(l, t, a), a = a.sibling;
  }
  function oo(l, t, a) {
    if (lt && typeof lt.onCommitFiberUnmount == "function")
      try {
        lt.onCommitFiberUnmount(qe, a);
      } catch {
      }
    switch (a.tag) {
      case 26:
        Ol || Dt(a, t), Jt(
          l,
          t,
          a
        ), a.memoizedState ? a.memoizedState.count-- : a.stateNode && (a = a.stateNode, a.parentNode.removeChild(a));
        break;
      case 27:
        Ol || Dt(a, t);
        var e = gl, u = wl;
        pa(a.type) && (gl = a.stateNode, wl = !1), Jt(
          l,
          t,
          a
        ), zu(a.stateNode), gl = e, wl = u;
        break;
      case 5:
        Ol || Dt(a, t);
      case 6:
        if (e = gl, u = wl, gl = null, Jt(
          l,
          t,
          a
        ), gl = e, wl = u, gl !== null)
          if (wl)
            try {
              (gl.nodeType === 9 ? gl.body : gl.nodeName === "HTML" ? gl.ownerDocument.body : gl).removeChild(a.stateNode);
            } catch (n) {
              fl(
                a,
                t,
                n
              );
            }
          else
            try {
              gl.removeChild(a.stateNode);
            } catch (n) {
              fl(
                a,
                t,
                n
              );
            }
        break;
      case 18:
        gl !== null && (wl ? (l = gl, em(
          l.nodeType === 9 ? l.body : l.nodeName === "HTML" ? l.ownerDocument.body : l,
          a.stateNode
        ), Re(l)) : em(gl, a.stateNode));
        break;
      case 4:
        e = gl, u = wl, gl = a.stateNode.containerInfo, wl = !0, Jt(
          l,
          t,
          a
        ), gl = e, wl = u;
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        ra(2, a, t), Ol || ra(4, a, t), Jt(
          l,
          t,
          a
        );
        break;
      case 1:
        Ol || (Dt(a, t), e = a.stateNode, typeof e.componentWillUnmount == "function" && eo(
          a,
          t,
          e
        )), Jt(
          l,
          t,
          a
        );
        break;
      case 21:
        Jt(
          l,
          t,
          a
        );
        break;
      case 22:
        Ol = (e = Ol) || a.memoizedState !== null, Jt(
          l,
          t,
          a
        ), Ol = e;
        break;
      default:
        Jt(
          l,
          t,
          a
        );
    }
  }
  function mo(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null))) {
      l = l.dehydrated;
      try {
        Re(l);
      } catch (a) {
        fl(t, t.return, a);
      }
    }
  }
  function ro(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null && (l = l.dehydrated, l !== null))))
      try {
        Re(l);
      } catch (a) {
        fl(t, t.return, a);
      }
  }
  function gh(l) {
    switch (l.tag) {
      case 31:
      case 13:
      case 19:
        var t = l.stateNode;
        return t === null && (t = l.stateNode = new co()), t;
      case 22:
        return l = l.stateNode, t = l._retryCache, t === null && (t = l._retryCache = new co()), t;
      default:
        throw Error(o(435, l.tag));
    }
  }
  function jn(l, t) {
    var a = gh(l);
    t.forEach(function(e) {
      if (!a.has(e)) {
        a.add(e);
        var u = xh.bind(null, l, e);
        e.then(u, u);
      }
    });
  }
  function $l(l, t) {
    var a = t.deletions;
    if (a !== null)
      for (var e = 0; e < a.length; e++) {
        var u = a[e], n = l, i = t, c = i;
        l: for (; c !== null; ) {
          switch (c.tag) {
            case 27:
              if (pa(c.type)) {
                gl = c.stateNode, wl = !1;
                break l;
              }
              break;
            case 5:
              gl = c.stateNode, wl = !1;
              break l;
            case 3:
            case 4:
              gl = c.stateNode.containerInfo, wl = !0;
              break l;
          }
          c = c.return;
        }
        if (gl === null) throw Error(o(160));
        oo(n, i, u), gl = null, wl = !1, n = u.alternate, n !== null && (n.return = null), u.return = null;
      }
    if (t.subtreeFlags & 13886)
      for (t = t.child; t !== null; )
        ho(t, l), t = t.sibling;
  }
  var jt = null;
  function ho(l, t) {
    var a = l.alternate, e = l.flags;
    switch (l.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        $l(t, l), Wl(l), e & 4 && (ra(3, l, l.return), ou(3, l), ra(5, l, l.return));
        break;
      case 1:
        $l(t, l), Wl(l), e & 512 && (Ol || a === null || Dt(a, a.return)), e & 64 && Kt && (l = l.updateQueue, l !== null && (e = l.callbacks, e !== null && (a = l.shared.hiddenCallbacks, l.shared.hiddenCallbacks = a === null ? e : a.concat(e))));
        break;
      case 26:
        var u = jt;
        if ($l(t, l), Wl(l), e & 512 && (Ol || a === null || Dt(a, a.return)), e & 4) {
          var n = a !== null ? a.memoizedState : null;
          if (e = l.memoizedState, a === null)
            if (e === null)
              if (l.stateNode === null) {
                l: {
                  e = l.type, a = l.memoizedProps, u = u.ownerDocument || u;
                  t: switch (e) {
                    case "title":
                      n = u.getElementsByTagName("title")[0], (!n || n[Ge] || n[Ul] || n.namespaceURI === "http://www.w3.org/2000/svg" || n.hasAttribute("itemprop")) && (n = u.createElement(e), u.head.insertBefore(
                        n,
                        u.querySelector("head > title")
                      )), ql(n, e, a), n[Ul] = l, Ml(n), e = n;
                      break l;
                    case "link":
                      var i = hm(
                        "link",
                        "href",
                        u
                      ).get(e + (a.href || ""));
                      if (i) {
                        for (var c = 0; c < i.length; c++)
                          if (n = i[c], n.getAttribute("href") === (a.href == null || a.href === "" ? null : a.href) && n.getAttribute("rel") === (a.rel == null ? null : a.rel) && n.getAttribute("title") === (a.title == null ? null : a.title) && n.getAttribute("crossorigin") === (a.crossOrigin == null ? null : a.crossOrigin)) {
                            i.splice(c, 1);
                            break t;
                          }
                      }
                      n = u.createElement(e), ql(n, e, a), u.head.appendChild(n);
                      break;
                    case "meta":
                      if (i = hm(
                        "meta",
                        "content",
                        u
                      ).get(e + (a.content || ""))) {
                        for (c = 0; c < i.length; c++)
                          if (n = i[c], n.getAttribute("content") === (a.content == null ? null : "" + a.content) && n.getAttribute("name") === (a.name == null ? null : a.name) && n.getAttribute("property") === (a.property == null ? null : a.property) && n.getAttribute("http-equiv") === (a.httpEquiv == null ? null : a.httpEquiv) && n.getAttribute("charset") === (a.charSet == null ? null : a.charSet)) {
                            i.splice(c, 1);
                            break t;
                          }
                      }
                      n = u.createElement(e), ql(n, e, a), u.head.appendChild(n);
                      break;
                    default:
                      throw Error(o(468, e));
                  }
                  n[Ul] = l, Ml(n), e = n;
                }
                l.stateNode = e;
              } else
                vm(
                  u,
                  l.type,
                  l.stateNode
                );
            else
              l.stateNode = rm(
                u,
                e,
                l.memoizedProps
              );
          else
            n !== e ? (n === null ? a.stateNode !== null && (a = a.stateNode, a.parentNode.removeChild(a)) : n.count--, e === null ? vm(
              u,
              l.type,
              l.stateNode
            ) : rm(
              u,
              e,
              l.memoizedProps
            )) : e === null && l.stateNode !== null && Uc(
              l,
              l.memoizedProps,
              a.memoizedProps
            );
        }
        break;
      case 27:
        $l(t, l), Wl(l), e & 512 && (Ol || a === null || Dt(a, a.return)), a !== null && e & 4 && Uc(
          l,
          l.memoizedProps,
          a.memoizedProps
        );
        break;
      case 5:
        if ($l(t, l), Wl(l), e & 512 && (Ol || a === null || Dt(a, a.return)), l.flags & 32) {
          u = l.stateNode;
          try {
            ae(u, "");
          } catch (R) {
            fl(l, l.return, R);
          }
        }
        e & 4 && l.stateNode != null && (u = l.memoizedProps, Uc(
          l,
          u,
          a !== null ? a.memoizedProps : u
        )), e & 1024 && (Hc = !0);
        break;
      case 6:
        if ($l(t, l), Wl(l), e & 4) {
          if (l.stateNode === null)
            throw Error(o(162));
          e = l.memoizedProps, a = l.stateNode;
          try {
            a.nodeValue = e;
          } catch (R) {
            fl(l, l.return, R);
          }
        }
        break;
      case 3:
        if (Qn = null, u = jt, jt = Yn(t.containerInfo), $l(t, l), jt = u, Wl(l), e & 4 && a !== null && a.memoizedState.isDehydrated)
          try {
            Re(t.containerInfo);
          } catch (R) {
            fl(l, l.return, R);
          }
        Hc && (Hc = !1, vo(l));
        break;
      case 4:
        e = jt, jt = Yn(
          l.stateNode.containerInfo
        ), $l(t, l), Wl(l), jt = e;
        break;
      case 12:
        $l(t, l), Wl(l);
        break;
      case 31:
        $l(t, l), Wl(l), e & 4 && (e = l.updateQueue, e !== null && (l.updateQueue = null, jn(l, e)));
        break;
      case 13:
        $l(t, l), Wl(l), l.child.flags & 8192 && l.memoizedState !== null != (a !== null && a.memoizedState !== null) && (xn = Pl()), e & 4 && (e = l.updateQueue, e !== null && (l.updateQueue = null, jn(l, e)));
        break;
      case 22:
        u = l.memoizedState !== null;
        var s = a !== null && a.memoizedState !== null, y = Kt, p = Ol;
        if (Kt = y || u, Ol = p || s, $l(t, l), Ol = p, Kt = y, Wl(l), e & 8192)
          l: for (t = l.stateNode, t._visibility = u ? t._visibility & -2 : t._visibility | 1, u && (a === null || s || Kt || Ol || Va(l)), a = null, t = l; ; ) {
            if (t.tag === 5 || t.tag === 26) {
              if (a === null) {
                s = a = t;
                try {
                  if (n = s.stateNode, u)
                    i = n.style, typeof i.setProperty == "function" ? i.setProperty("display", "none", "important") : i.display = "none";
                  else {
                    c = s.stateNode;
                    var j = s.memoizedProps.style, g = j != null && j.hasOwnProperty("display") ? j.display : null;
                    c.style.display = g == null || typeof g == "boolean" ? "" : ("" + g).trim();
                  }
                } catch (R) {
                  fl(s, s.return, R);
                }
              }
            } else if (t.tag === 6) {
              if (a === null) {
                s = t;
                try {
                  s.stateNode.nodeValue = u ? "" : s.memoizedProps;
                } catch (R) {
                  fl(s, s.return, R);
                }
              }
            } else if (t.tag === 18) {
              if (a === null) {
                s = t;
                try {
                  var S = s.stateNode;
                  u ? um(S, !0) : um(s.stateNode, !1);
                } catch (R) {
                  fl(s, s.return, R);
                }
              }
            } else if ((t.tag !== 22 && t.tag !== 23 || t.memoizedState === null || t === l) && t.child !== null) {
              t.child.return = t, t = t.child;
              continue;
            }
            if (t === l) break l;
            for (; t.sibling === null; ) {
              if (t.return === null || t.return === l) break l;
              a === t && (a = null), t = t.return;
            }
            a === t && (a = null), t.sibling.return = t.return, t = t.sibling;
          }
        e & 4 && (e = l.updateQueue, e !== null && (a = e.retryQueue, a !== null && (e.retryQueue = null, jn(l, a))));
        break;
      case 19:
        $l(t, l), Wl(l), e & 4 && (e = l.updateQueue, e !== null && (l.updateQueue = null, jn(l, e)));
        break;
      case 30:
        break;
      case 21:
        break;
      default:
        $l(t, l), Wl(l);
    }
  }
  function Wl(l) {
    var t = l.flags;
    if (t & 2) {
      try {
        for (var a, e = l.return; e !== null; ) {
          if (no(e)) {
            a = e;
            break;
          }
          e = e.return;
        }
        if (a == null) throw Error(o(160));
        switch (a.tag) {
          case 27:
            var u = a.stateNode, n = Rc(l);
            Tn(l, n, u);
            break;
          case 5:
            var i = a.stateNode;
            a.flags & 32 && (ae(i, ""), a.flags &= -33);
            var c = Rc(l);
            Tn(l, c, i);
            break;
          case 3:
          case 4:
            var s = a.stateNode.containerInfo, y = Rc(l);
            Cc(
              l,
              y,
              s
            );
            break;
          default:
            throw Error(o(161));
        }
      } catch (p) {
        fl(l, l.return, p);
      }
      l.flags &= -3;
    }
    t & 4096 && (l.flags &= -4097);
  }
  function vo(l) {
    if (l.subtreeFlags & 1024)
      for (l = l.child; l !== null; ) {
        var t = l;
        vo(t), t.tag === 5 && t.flags & 1024 && t.stateNode.reset(), l = l.sibling;
      }
  }
  function wt(l, t) {
    if (t.subtreeFlags & 8772)
      for (t = t.child; t !== null; )
        fo(l, t.alternate, t), t = t.sibling;
  }
  function Va(l) {
    for (l = l.child; l !== null; ) {
      var t = l;
      switch (t.tag) {
        case 0:
        case 11:
        case 14:
        case 15:
          ra(4, t, t.return), Va(t);
          break;
        case 1:
          Dt(t, t.return);
          var a = t.stateNode;
          typeof a.componentWillUnmount == "function" && eo(
            t,
            t.return,
            a
          ), Va(t);
          break;
        case 27:
          zu(t.stateNode);
        case 26:
        case 5:
          Dt(t, t.return), Va(t);
          break;
        case 22:
          t.memoizedState === null && Va(t);
          break;
        case 30:
          Va(t);
          break;
        default:
          Va(t);
      }
      l = l.sibling;
    }
  }
  function $t(l, t, a) {
    for (a = a && (t.subtreeFlags & 8772) !== 0, t = t.child; t !== null; ) {
      var e = t.alternate, u = l, n = t, i = n.flags;
      switch (n.tag) {
        case 0:
        case 11:
        case 15:
          $t(
            u,
            n,
            a
          ), ou(4, n);
          break;
        case 1:
          if ($t(
            u,
            n,
            a
          ), e = n, u = e.stateNode, typeof u.componentDidMount == "function")
            try {
              u.componentDidMount();
            } catch (y) {
              fl(e, e.return, y);
            }
          if (e = n, u = e.updateQueue, u !== null) {
            var c = e.stateNode;
            try {
              var s = u.shared.hiddenCallbacks;
              if (s !== null)
                for (u.shared.hiddenCallbacks = null, u = 0; u < s.length; u++)
                  Ks(s[u], c);
            } catch (y) {
              fl(e, e.return, y);
            }
          }
          a && i & 64 && ao(n), mu(n, n.return);
          break;
        case 27:
          io(n);
        case 26:
        case 5:
          $t(
            u,
            n,
            a
          ), a && e === null && i & 4 && uo(n), mu(n, n.return);
          break;
        case 12:
          $t(
            u,
            n,
            a
          );
          break;
        case 31:
          $t(
            u,
            n,
            a
          ), a && i & 4 && mo(u, n);
          break;
        case 13:
          $t(
            u,
            n,
            a
          ), a && i & 4 && ro(u, n);
          break;
        case 22:
          n.memoizedState === null && $t(
            u,
            n,
            a
          ), mu(n, n.return);
          break;
        case 30:
          break;
        default:
          $t(
            u,
            n,
            a
          );
      }
      t = t.sibling;
    }
  }
  function qc(l, t) {
    var a = null;
    l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (a = l.memoizedState.cachePool.pool), l = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (l = t.memoizedState.cachePool.pool), l !== a && (l != null && l.refCount++, a != null && Ie(a));
  }
  function Bc(l, t) {
    l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Ie(l));
  }
  function Et(l, t, a, e) {
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; )
        yo(
          l,
          t,
          a,
          e
        ), t = t.sibling;
  }
  function yo(l, t, a, e) {
    var u = t.flags;
    switch (t.tag) {
      case 0:
      case 11:
      case 15:
        Et(
          l,
          t,
          a,
          e
        ), u & 2048 && ou(9, t);
        break;
      case 1:
        Et(
          l,
          t,
          a,
          e
        );
        break;
      case 3:
        Et(
          l,
          t,
          a,
          e
        ), u & 2048 && (l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Ie(l)));
        break;
      case 12:
        if (u & 2048) {
          Et(
            l,
            t,
            a,
            e
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
            fl(t, t.return, s);
          }
        } else
          Et(
            l,
            t,
            a,
            e
          );
        break;
      case 31:
        Et(
          l,
          t,
          a,
          e
        );
        break;
      case 13:
        Et(
          l,
          t,
          a,
          e
        );
        break;
      case 23:
        break;
      case 22:
        n = t.stateNode, i = t.alternate, t.memoizedState !== null ? n._visibility & 2 ? Et(
          l,
          t,
          a,
          e
        ) : ru(l, t) : n._visibility & 2 ? Et(
          l,
          t,
          a,
          e
        ) : (n._visibility |= 2, Ae(
          l,
          t,
          a,
          e,
          (t.subtreeFlags & 10256) !== 0 || !1
        )), u & 2048 && qc(i, t);
        break;
      case 24:
        Et(
          l,
          t,
          a,
          e
        ), u & 2048 && Bc(t.alternate, t);
        break;
      default:
        Et(
          l,
          t,
          a,
          e
        );
    }
  }
  function Ae(l, t, a, e, u) {
    for (u = u && ((t.subtreeFlags & 10256) !== 0 || !1), t = t.child; t !== null; ) {
      var n = l, i = t, c = a, s = e, y = i.flags;
      switch (i.tag) {
        case 0:
        case 11:
        case 15:
          Ae(
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
          i.memoizedState !== null ? p._visibility & 2 ? Ae(
            n,
            i,
            c,
            s,
            u
          ) : ru(
            n,
            i
          ) : (p._visibility |= 2, Ae(
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
          Ae(
            n,
            i,
            c,
            s,
            u
          ), u && y & 2048 && Bc(i.alternate, i);
          break;
        default:
          Ae(
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
        var a = l, e = t, u = e.flags;
        switch (e.tag) {
          case 22:
            ru(a, e), u & 2048 && qc(
              e.alternate,
              e
            );
            break;
          case 24:
            ru(a, e), u & 2048 && Bc(e.alternate, e);
            break;
          default:
            ru(a, e);
        }
        t = t.sibling;
      }
  }
  var hu = 8192;
  function Te(l, t, a) {
    if (l.subtreeFlags & hu)
      for (l = l.child; l !== null; )
        go(
          l,
          t,
          a
        ), l = l.sibling;
  }
  function go(l, t, a) {
    switch (l.tag) {
      case 26:
        Te(
          l,
          t,
          a
        ), l.flags & hu && l.memoizedState !== null && ev(
          a,
          jt,
          l.memoizedState,
          l.memoizedProps
        );
        break;
      case 5:
        Te(
          l,
          t,
          a
        );
        break;
      case 3:
      case 4:
        var e = jt;
        jt = Yn(l.stateNode.containerInfo), Te(
          l,
          t,
          a
        ), jt = e;
        break;
      case 22:
        l.memoizedState === null && (e = l.alternate, e !== null && e.memoizedState !== null ? (e = hu, hu = 16777216, Te(
          l,
          t,
          a
        ), hu = e) : Te(
          l,
          t,
          a
        ));
        break;
      default:
        Te(
          l,
          t,
          a
        );
    }
  }
  function So(l) {
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
        for (var a = 0; a < t.length; a++) {
          var e = t[a];
          Dl = e, po(
            e,
            l
          );
        }
      So(l);
    }
    if (l.subtreeFlags & 10256)
      for (l = l.child; l !== null; )
        bo(l), l = l.sibling;
  }
  function bo(l) {
    switch (l.tag) {
      case 0:
      case 11:
      case 15:
        vu(l), l.flags & 2048 && ra(9, l, l.return);
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
        for (var a = 0; a < t.length; a++) {
          var e = t[a];
          Dl = e, po(
            e,
            l
          );
        }
      So(l);
    }
    for (l = l.child; l !== null; ) {
      switch (t = l, t.tag) {
        case 0:
        case 11:
        case 15:
          ra(8, t, t.return), En(t);
          break;
        case 22:
          a = t.stateNode, a._visibility & 2 && (a._visibility &= -3, En(t));
          break;
        default:
          En(t);
      }
      l = l.sibling;
    }
  }
  function po(l, t) {
    for (; Dl !== null; ) {
      var a = Dl;
      switch (a.tag) {
        case 0:
        case 11:
        case 15:
          ra(8, a, t);
          break;
        case 23:
        case 22:
          if (a.memoizedState !== null && a.memoizedState.cachePool !== null) {
            var e = a.memoizedState.cachePool.pool;
            e != null && e.refCount++;
          }
          break;
        case 24:
          Ie(a.memoizedState.cache);
      }
      if (e = a.child, e !== null) e.return = a, Dl = e;
      else
        l: for (a = l; Dl !== null; ) {
          e = Dl;
          var u = e.sibling, n = e.return;
          if (so(e), e === a) {
            Dl = null;
            break l;
          }
          if (u !== null) {
            u.return = n, Dl = u;
            break l;
          }
          Dl = n;
        }
    }
  }
  var Sh = {
    getCacheForType: function(l) {
      var t = Cl(El), a = t.data.get(l);
      return a === void 0 && (a = l(), t.data.set(l, a)), a;
    },
    cacheSignal: function() {
      return Cl(El).controller.signal;
    }
  }, bh = typeof WeakMap == "function" ? WeakMap : Map, nl = 0, hl = null, $ = null, k = 0, cl = 0, it = null, ha = !1, je = !1, Yc = !1, Wt = 0, pl = 0, va = 0, Ka = 0, Gc = 0, ct = 0, Ee = 0, yu = null, kl = null, Qc = !1, xn = 0, zo = 0, _n = 1 / 0, On = null, ya = null, Nl = 0, ga = null, xe = null, kt = 0, Xc = 0, Lc = null, Ao = null, gu = 0, Zc = null;
  function ft() {
    return (nl & 2) !== 0 && k !== 0 ? k & -k : z.T !== null ? Wc() : Bf();
  }
  function To() {
    if (ct === 0)
      if ((k & 536870912) === 0 || P) {
        var l = Hu;
        Hu <<= 1, (Hu & 3932160) === 0 && (Hu = 262144), ct = l;
      } else ct = 536870912;
    return l = ut.current, l !== null && (l.flags |= 32), ct;
  }
  function Fl(l, t, a) {
    (l === hl && (cl === 2 || cl === 9) || l.cancelPendingCommit !== null) && (_e(l, 0), Sa(
      l,
      k,
      ct,
      !1
    )), Ye(l, a), ((nl & 2) === 0 || l !== hl) && (l === hl && ((nl & 2) === 0 && (Ka |= a), pl === 4 && Sa(
      l,
      k,
      ct,
      !1
    )), Ut(l));
  }
  function jo(l, t, a) {
    if ((nl & 6) !== 0) throw Error(o(327));
    var e = !a && (t & 127) === 0 && (t & l.expiredLanes) === 0 || Be(l, t), u = e ? Ah(l, t) : Kc(l, t, !0), n = e;
    do {
      if (u === 0) {
        je && !e && Sa(l, t, 0, !1);
        break;
      } else {
        if (a = l.current.alternate, n && !ph(a)) {
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
              if (s && (_e(c, i).flags |= 256), i = Kc(
                c,
                i,
                !1
              ), i !== 2) {
                if (Yc && !s) {
                  c.errorRecoveryDisabledLanes |= n, Ka |= n, u = 4;
                  break l;
                }
                n = kl, kl = u, n !== null && (kl === null ? kl = n : kl.push.apply(
                  kl,
                  n
                ));
              }
              u = i;
            }
            if (n = !1, u !== 2) continue;
          }
        }
        if (u === 1) {
          _e(l, 0), Sa(l, t, 0, !0);
          break;
        }
        l: {
          switch (e = l, n = u, n) {
            case 0:
            case 1:
              throw Error(o(345));
            case 4:
              if ((t & 4194048) !== t) break;
            case 6:
              Sa(
                e,
                t,
                ct,
                !ha
              );
              break l;
            case 2:
              kl = null;
              break;
            case 3:
            case 5:
              break;
            default:
              throw Error(o(329));
          }
          if ((t & 62914560) === t && (u = xn + 300 - Pl(), 10 < u)) {
            if (Sa(
              e,
              t,
              ct,
              !ha
            ), Bu(e, 0, !0) !== 0) break l;
            kt = t, e.timeoutHandle = tm(
              Eo.bind(
                null,
                e,
                a,
                kl,
                On,
                Qc,
                t,
                ct,
                Ka,
                Ee,
                ha,
                n,
                "Throttled",
                -0,
                0
              ),
              u
            );
            break l;
          }
          Eo(
            e,
            a,
            kl,
            On,
            Qc,
            t,
            ct,
            Ka,
            Ee,
            ha,
            n,
            null,
            -0,
            0
          );
        }
      }
      break;
    } while (!0);
    Ut(l);
  }
  function Eo(l, t, a, e, u, n, i, c, s, y, p, j, g, S) {
    if (l.timeoutHandle = -1, j = t.subtreeFlags, j & 8192 || (j & 16785408) === 16785408) {
      j = {
        stylesheets: null,
        count: 0,
        imgCount: 0,
        imgBytes: 0,
        suspenseyImages: [],
        waitingForImages: !0,
        waitingForViewTransition: !1,
        unsuspend: Ht
      }, go(
        t,
        n,
        j
      );
      var R = (n & 62914560) === n ? xn - Pl() : (n & 4194048) === n ? zo - Pl() : 0;
      if (R = uv(
        j,
        R
      ), R !== null) {
        kt = n, l.cancelPendingCommit = R(
          Ro.bind(
            null,
            l,
            t,
            n,
            a,
            e,
            u,
            i,
            c,
            s,
            p,
            j,
            null,
            g,
            S
          )
        ), Sa(l, n, i, !y);
        return;
      }
    }
    Ro(
      l,
      t,
      n,
      a,
      e,
      u,
      i,
      c,
      s
    );
  }
  function ph(l) {
    for (var t = l; ; ) {
      var a = t.tag;
      if ((a === 0 || a === 11 || a === 15) && t.flags & 16384 && (a = t.updateQueue, a !== null && (a = a.stores, a !== null)))
        for (var e = 0; e < a.length; e++) {
          var u = a[e], n = u.getSnapshot;
          u = u.value;
          try {
            if (!at(n(), u)) return !1;
          } catch {
            return !1;
          }
        }
      if (a = t.child, t.subtreeFlags & 16384 && a !== null)
        a.return = t, t = a;
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
  function Sa(l, t, a, e) {
    t &= ~Gc, t &= ~Ka, l.suspendedLanes |= t, l.pingedLanes &= ~t, e && (l.warmLanes |= t), e = l.expirationTimes;
    for (var u = t; 0 < u; ) {
      var n = 31 - tt(u), i = 1 << n;
      e[n] = -1, u &= ~i;
    }
    a !== 0 && Cf(l, a, t);
  }
  function Nn() {
    return (nl & 6) === 0 ? (Su(0), !1) : !0;
  }
  function Vc() {
    if ($ !== null) {
      if (cl === 0)
        var l = $.return;
      else
        l = $, Gt = qa = null, ic(l), ge = null, lu = 0, l = $;
      for (; l !== null; )
        to(l.alternate, l), l = l.return;
      $ = null;
    }
  }
  function _e(l, t) {
    var a = l.timeoutHandle;
    a !== -1 && (l.timeoutHandle = -1, Qh(a)), a = l.cancelPendingCommit, a !== null && (l.cancelPendingCommit = null, a()), kt = 0, Vc(), hl = l, $ = a = Bt(l.current, null), k = t, cl = 0, it = null, ha = !1, je = Be(l, t), Yc = !1, Ee = ct = Gc = Ka = va = pl = 0, kl = yu = null, Qc = !1, (t & 8) !== 0 && (t |= t & 32);
    var e = l.entangledLanes;
    if (e !== 0)
      for (l = l.entanglements, e &= t; 0 < e; ) {
        var u = 31 - tt(e), n = 1 << u;
        t |= l[u], e &= ~n;
      }
    return Wt = t, Wu(), a;
  }
  function xo(l, t) {
    K = null, z.H = fu, t === ye || t === en ? (t = Xs(), cl = 3) : t === $i ? (t = Xs(), cl = 4) : cl = t === Ac ? 8 : t !== null && typeof t == "object" && typeof t.then == "function" ? 6 : 1, it = t, $ === null && (pl = 1, Sn(
      l,
      vt(t, l.current)
    ));
  }
  function _o() {
    var l = ut.current;
    return l === null ? !0 : (k & 4194048) === k ? bt === null : (k & 62914560) === k || (k & 536870912) !== 0 ? l === bt : !1;
  }
  function Oo() {
    var l = z.H;
    return z.H = fu, l === null ? fu : l;
  }
  function No() {
    var l = z.A;
    return z.A = Sh, l;
  }
  function Mn() {
    pl = 4, ha || (k & 4194048) !== k && ut.current !== null || (je = !0), (va & 134217727) === 0 && (Ka & 134217727) === 0 || hl === null || Sa(
      hl,
      k,
      ct,
      !1
    );
  }
  function Kc(l, t, a) {
    var e = nl;
    nl |= 2;
    var u = Oo(), n = No();
    (hl !== l || k !== t) && (On = null, _e(l, t)), t = !1;
    var i = pl;
    l: do
      try {
        if (cl !== 0 && $ !== null) {
          var c = $, s = it;
          switch (cl) {
            case 8:
              Vc(), i = 6;
              break l;
            case 3:
            case 2:
            case 9:
            case 6:
              ut.current === null && (t = !0);
              var y = cl;
              if (cl = 0, it = null, Oe(l, c, s, y), a && je) {
                i = 0;
                break l;
              }
              break;
            default:
              y = cl, cl = 0, it = null, Oe(l, c, s, y);
          }
        }
        zh(), i = pl;
        break;
      } catch (p) {
        xo(l, p);
      }
    while (!0);
    return t && l.shellSuspendCounter++, Gt = qa = null, nl = e, z.H = u, z.A = n, $ === null && (hl = null, k = 0, Wu()), i;
  }
  function zh() {
    for (; $ !== null; ) Mo($);
  }
  function Ah(l, t) {
    var a = nl;
    nl |= 2;
    var e = Oo(), u = No();
    hl !== l || k !== t ? (On = null, _n = Pl() + 500, _e(l, t)) : je = Be(
      l,
      t
    );
    l: do
      try {
        if (cl !== 0 && $ !== null) {
          t = $;
          var n = it;
          t: switch (cl) {
            case 1:
              cl = 0, it = null, Oe(l, t, n, 1);
              break;
            case 2:
            case 9:
              if (Gs(n)) {
                cl = 0, it = null, Do(t);
                break;
              }
              t = function() {
                cl !== 2 && cl !== 9 || hl !== l || (cl = 7), Ut(l);
              }, n.then(t, t);
              break l;
            case 3:
              cl = 7;
              break l;
            case 4:
              cl = 5;
              break l;
            case 7:
              Gs(n) ? (cl = 0, it = null, Do(t)) : (cl = 0, it = null, Oe(l, t, n, 7));
              break;
            case 5:
              var i = null;
              switch ($.tag) {
                case 26:
                  i = $.memoizedState;
                case 5:
                case 27:
                  var c = $;
                  if (i ? ym(i) : c.stateNode.complete) {
                    cl = 0, it = null;
                    var s = c.sibling;
                    if (s !== null) $ = s;
                    else {
                      var y = c.return;
                      y !== null ? ($ = y, Dn(y)) : $ = null;
                    }
                    break t;
                  }
              }
              cl = 0, it = null, Oe(l, t, n, 5);
              break;
            case 6:
              cl = 0, it = null, Oe(l, t, n, 6);
              break;
            case 8:
              Vc(), pl = 6;
              break l;
            default:
              throw Error(o(462));
          }
        }
        Th();
        break;
      } catch (p) {
        xo(l, p);
      }
    while (!0);
    return Gt = qa = null, z.H = e, z.A = u, nl = a, $ !== null ? 0 : (hl = null, k = 0, Wu(), pl);
  }
  function Th() {
    for (; $ !== null && !Jm(); )
      Mo($);
  }
  function Mo(l) {
    var t = Pd(l.alternate, l, Wt);
    l.memoizedProps = l.pendingProps, t === null ? Dn(l) : $ = t;
  }
  function Do(l) {
    var t = l, a = t.alternate;
    switch (t.tag) {
      case 15:
      case 0:
        t = wd(
          a,
          t,
          t.pendingProps,
          t.type,
          void 0,
          k
        );
        break;
      case 11:
        t = wd(
          a,
          t,
          t.pendingProps,
          t.type.render,
          t.ref,
          k
        );
        break;
      case 5:
        ic(t);
      default:
        to(a, t), t = $ = Os(t, Wt), t = Pd(a, t, Wt);
    }
    l.memoizedProps = l.pendingProps, t === null ? Dn(l) : $ = t;
  }
  function Oe(l, t, a, e) {
    Gt = qa = null, ic(t), ge = null, lu = 0;
    var u = t.return;
    try {
      if (oh(
        l,
        u,
        t,
        a,
        k
      )) {
        pl = 1, Sn(
          l,
          vt(a, l.current)
        ), $ = null;
        return;
      }
    } catch (n) {
      if (u !== null) throw $ = u, n;
      pl = 1, Sn(
        l,
        vt(a, l.current)
      ), $ = null;
      return;
    }
    t.flags & 32768 ? (P || e === 1 ? l = !0 : je || (k & 536870912) !== 0 ? l = !1 : (ha = l = !0, (e === 2 || e === 9 || e === 3 || e === 6) && (e = ut.current, e !== null && e.tag === 13 && (e.flags |= 16384))), Uo(t, l)) : Dn(t);
  }
  function Dn(l) {
    var t = l;
    do {
      if ((t.flags & 32768) !== 0) {
        Uo(
          t,
          ha
        );
        return;
      }
      l = t.return;
      var a = hh(
        t.alternate,
        t,
        Wt
      );
      if (a !== null) {
        $ = a;
        return;
      }
      if (t = t.sibling, t !== null) {
        $ = t;
        return;
      }
      $ = t = l;
    } while (t !== null);
    pl === 0 && (pl = 5);
  }
  function Uo(l, t) {
    do {
      var a = vh(l.alternate, l);
      if (a !== null) {
        a.flags &= 32767, $ = a;
        return;
      }
      if (a = l.return, a !== null && (a.flags |= 32768, a.subtreeFlags = 0, a.deletions = null), !t && (l = l.sibling, l !== null)) {
        $ = l;
        return;
      }
      $ = l = a;
    } while (l !== null);
    pl = 6, $ = null;
  }
  function Ro(l, t, a, e, u, n, i, c, s) {
    l.cancelPendingCommit = null;
    do
      Un();
    while (Nl !== 0);
    if ((nl & 6) !== 0) throw Error(o(327));
    if (t !== null) {
      if (t === l.current) throw Error(o(177));
      if (n = t.lanes | t.childLanes, n |= Ri, ar(
        l,
        a,
        n,
        i,
        c,
        s
      ), l === hl && ($ = hl = null, k = 0), xe = t, ga = l, kt = a, Xc = n, Lc = u, Ao = e, (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? (l.callbackNode = null, l.callbackPriority = 0, _h(Ru, function() {
        return Yo(), null;
      })) : (l.callbackNode = null, l.callbackPriority = 0), e = (t.flags & 13878) !== 0, (t.subtreeFlags & 13878) !== 0 || e) {
        e = z.T, z.T = null, u = D.p, D.p = 2, i = nl, nl |= 4;
        try {
          yh(l, t, a);
        } finally {
          nl = i, D.p = u, z.T = e;
        }
      }
      Nl = 1, Co(), Ho(), qo();
    }
  }
  function Co() {
    if (Nl === 1) {
      Nl = 0;
      var l = ga, t = xe, a = (t.flags & 13878) !== 0;
      if ((t.subtreeFlags & 13878) !== 0 || a) {
        a = z.T, z.T = null;
        var e = D.p;
        D.p = 2;
        var u = nl;
        nl |= 4;
        try {
          ho(t, l);
          var n = ef, i = bs(l.containerInfo), c = n.focusedElem, s = n.selectionRange;
          if (i !== c && c && c.ownerDocument && Ss(
            c.ownerDocument.documentElement,
            c
          )) {
            if (s !== null && Oi(c)) {
              var y = s.start, p = s.end;
              if (p === void 0 && (p = y), "selectionStart" in c)
                c.selectionStart = y, c.selectionEnd = Math.min(
                  p,
                  c.value.length
                );
              else {
                var j = c.ownerDocument || document, g = j && j.defaultView || window;
                if (g.getSelection) {
                  var S = g.getSelection(), R = c.textContent.length, G = Math.min(s.start, R), ml = s.end === void 0 ? G : Math.min(s.end, R);
                  !S.extend && G > ml && (i = ml, ml = G, G = i);
                  var h = gs(
                    c,
                    G
                  ), d = gs(
                    c,
                    ml
                  );
                  if (h && d && (S.rangeCount !== 1 || S.anchorNode !== h.node || S.anchorOffset !== h.offset || S.focusNode !== d.node || S.focusOffset !== d.offset)) {
                    var v = j.createRange();
                    v.setStart(h.node, h.offset), S.removeAllRanges(), G > ml ? (S.addRange(v), S.extend(d.node, d.offset)) : (v.setEnd(d.node, d.offset), S.addRange(v));
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
          Vn = !!af, ef = af = null;
        } finally {
          nl = u, D.p = e, z.T = a;
        }
      }
      l.current = t, Nl = 2;
    }
  }
  function Ho() {
    if (Nl === 2) {
      Nl = 0;
      var l = ga, t = xe, a = (t.flags & 8772) !== 0;
      if ((t.subtreeFlags & 8772) !== 0 || a) {
        a = z.T, z.T = null;
        var e = D.p;
        D.p = 2;
        var u = nl;
        nl |= 4;
        try {
          fo(l, t.alternate, t);
        } finally {
          nl = u, D.p = e, z.T = a;
        }
      }
      Nl = 3;
    }
  }
  function qo() {
    if (Nl === 4 || Nl === 3) {
      Nl = 0, wm();
      var l = ga, t = xe, a = kt, e = Ao;
      (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? Nl = 5 : (Nl = 0, xe = ga = null, Bo(l, l.pendingLanes));
      var u = l.pendingLanes;
      if (u === 0 && (ya = null), si(a), t = t.stateNode, lt && typeof lt.onCommitFiberRoot == "function")
        try {
          lt.onCommitFiberRoot(
            qe,
            t,
            void 0,
            (t.current.flags & 128) === 128
          );
        } catch {
        }
      if (e !== null) {
        t = z.T, u = D.p, D.p = 2, z.T = null;
        try {
          for (var n = l.onRecoverableError, i = 0; i < e.length; i++) {
            var c = e[i];
            n(c.value, {
              componentStack: c.stack
            });
          }
        } finally {
          z.T = t, D.p = u;
        }
      }
      (kt & 3) !== 0 && Un(), Ut(l), u = l.pendingLanes, (a & 261930) !== 0 && (u & 42) !== 0 ? l === Zc ? gu++ : (gu = 0, Zc = l) : gu = 0, Su(0);
    }
  }
  function Bo(l, t) {
    (l.pooledCacheLanes &= t) === 0 && (t = l.pooledCache, t != null && (l.pooledCache = null, Ie(t)));
  }
  function Un() {
    return Co(), Ho(), qo(), Yo();
  }
  function Yo() {
    if (Nl !== 5) return !1;
    var l = ga, t = Xc;
    Xc = 0;
    var a = si(kt), e = z.T, u = D.p;
    try {
      D.p = 32 > a ? 32 : a, z.T = null, a = Lc, Lc = null;
      var n = ga, i = kt;
      if (Nl = 0, xe = ga = null, kt = 0, (nl & 6) !== 0) throw Error(o(331));
      var c = nl;
      if (nl |= 4, bo(n.current), yo(
        n,
        n.current,
        i,
        a
      ), nl = c, Su(0, !1), lt && typeof lt.onPostCommitFiberRoot == "function")
        try {
          lt.onPostCommitFiberRoot(qe, n);
        } catch {
        }
      return !0;
    } finally {
      D.p = u, z.T = e, Bo(l, t);
    }
  }
  function Go(l, t, a) {
    t = vt(a, t), t = zc(l.stateNode, t, 2), l = da(l, t, 2), l !== null && (Ye(l, 2), Ut(l));
  }
  function fl(l, t, a) {
    if (l.tag === 3)
      Go(l, l, a);
    else
      for (; t !== null; ) {
        if (t.tag === 3) {
          Go(
            t,
            l,
            a
          );
          break;
        } else if (t.tag === 1) {
          var e = t.stateNode;
          if (typeof t.type.getDerivedStateFromError == "function" || typeof e.componentDidCatch == "function" && (ya === null || !ya.has(e))) {
            l = vt(a, l), a = Gd(2), e = da(t, a, 2), e !== null && (Qd(
              a,
              e,
              t,
              l
            ), Ye(e, 2), Ut(e));
            break;
          }
        }
        t = t.return;
      }
  }
  function Jc(l, t, a) {
    var e = l.pingCache;
    if (e === null) {
      e = l.pingCache = new bh();
      var u = /* @__PURE__ */ new Set();
      e.set(t, u);
    } else
      u = e.get(t), u === void 0 && (u = /* @__PURE__ */ new Set(), e.set(t, u));
    u.has(a) || (Yc = !0, u.add(a), l = jh.bind(null, l, t, a), t.then(l, l));
  }
  function jh(l, t, a) {
    var e = l.pingCache;
    e !== null && e.delete(t), l.pingedLanes |= l.suspendedLanes & a, l.warmLanes &= ~a, hl === l && (k & a) === a && (pl === 4 || pl === 3 && (k & 62914560) === k && 300 > Pl() - xn ? (nl & 2) === 0 && _e(l, 0) : Gc |= a, Ee === k && (Ee = 0)), Ut(l);
  }
  function Qo(l, t) {
    t === 0 && (t = Rf()), l = Ra(l, t), l !== null && (Ye(l, t), Ut(l));
  }
  function Eh(l) {
    var t = l.memoizedState, a = 0;
    t !== null && (a = t.retryLane), Qo(l, a);
  }
  function xh(l, t) {
    var a = 0;
    switch (l.tag) {
      case 31:
      case 13:
        var e = l.stateNode, u = l.memoizedState;
        u !== null && (a = u.retryLane);
        break;
      case 19:
        e = l.stateNode;
        break;
      case 22:
        e = l.stateNode._retryCache;
        break;
      default:
        throw Error(o(314));
    }
    e !== null && e.delete(t), Qo(l, a);
  }
  function _h(l, t) {
    return ni(l, t);
  }
  var Rn = null, Ne = null, wc = !1, Cn = !1, $c = !1, ba = 0;
  function Ut(l) {
    l !== Ne && l.next === null && (Ne === null ? Rn = Ne = l : Ne = Ne.next = l), Cn = !0, wc || (wc = !0, Nh());
  }
  function Su(l, t) {
    if (!$c && Cn) {
      $c = !0;
      do
        for (var a = !1, e = Rn; e !== null; ) {
          if (l !== 0) {
            var u = e.pendingLanes;
            if (u === 0) var n = 0;
            else {
              var i = e.suspendedLanes, c = e.pingedLanes;
              n = (1 << 31 - tt(42 | l) + 1) - 1, n &= u & ~(i & ~c), n = n & 201326741 ? n & 201326741 | 1 : n ? n | 2 : 0;
            }
            n !== 0 && (a = !0, Vo(e, n));
          } else
            n = k, n = Bu(
              e,
              e === hl ? n : 0,
              e.cancelPendingCommit !== null || e.timeoutHandle !== -1
            ), (n & 3) === 0 || Be(e, n) || (a = !0, Vo(e, n));
          e = e.next;
        }
      while (a);
      $c = !1;
    }
  }
  function Oh() {
    Xo();
  }
  function Xo() {
    Cn = wc = !1;
    var l = 0;
    ba !== 0 && Gh() && (l = ba);
    for (var t = Pl(), a = null, e = Rn; e !== null; ) {
      var u = e.next, n = Lo(e, t);
      n === 0 ? (e.next = null, a === null ? Rn = u : a.next = u, u === null && (Ne = a)) : (a = e, (l !== 0 || (n & 3) !== 0) && (Cn = !0)), e = u;
    }
    Nl !== 0 && Nl !== 5 || Su(l), ba !== 0 && (ba = 0);
  }
  function Lo(l, t) {
    for (var a = l.suspendedLanes, e = l.pingedLanes, u = l.expirationTimes, n = l.pendingLanes & -62914561; 0 < n; ) {
      var i = 31 - tt(n), c = 1 << i, s = u[i];
      s === -1 ? ((c & a) === 0 || (c & e) !== 0) && (u[i] = tr(c, t)) : s <= t && (l.expiredLanes |= c), n &= ~c;
    }
    if (t = hl, a = k, a = Bu(
      l,
      l === t ? a : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), e = l.callbackNode, a === 0 || l === t && (cl === 2 || cl === 9) || l.cancelPendingCommit !== null)
      return e !== null && e !== null && ii(e), l.callbackNode = null, l.callbackPriority = 0;
    if ((a & 3) === 0 || Be(l, a)) {
      if (t = a & -a, t === l.callbackPriority) return t;
      switch (e !== null && ii(e), si(a)) {
        case 2:
        case 8:
          a = Df;
          break;
        case 32:
          a = Ru;
          break;
        case 268435456:
          a = Uf;
          break;
        default:
          a = Ru;
      }
      return e = Zo.bind(null, l), a = ni(a, e), l.callbackPriority = t, l.callbackNode = a, t;
    }
    return e !== null && e !== null && ii(e), l.callbackPriority = 2, l.callbackNode = null, 2;
  }
  function Zo(l, t) {
    if (Nl !== 0 && Nl !== 5)
      return l.callbackNode = null, l.callbackPriority = 0, null;
    var a = l.callbackNode;
    if (Un() && l.callbackNode !== a)
      return null;
    var e = k;
    return e = Bu(
      l,
      l === hl ? e : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), e === 0 ? null : (jo(l, e, t), Lo(l, Pl()), l.callbackNode != null && l.callbackNode === a ? Zo.bind(null, l) : null);
  }
  function Vo(l, t) {
    if (Un()) return null;
    jo(l, t, !0);
  }
  function Nh() {
    Xh(function() {
      (nl & 6) !== 0 ? ni(
        Mf,
        Oh
      ) : Xo();
    });
  }
  function Wc() {
    if (ba === 0) {
      var l = he;
      l === 0 && (l = Cu, Cu <<= 1, (Cu & 261888) === 0 && (Cu = 256)), ba = l;
    }
    return ba;
  }
  function Ko(l) {
    return l == null || typeof l == "symbol" || typeof l == "boolean" ? null : typeof l == "function" ? l : Xu("" + l);
  }
  function Jo(l, t) {
    var a = t.ownerDocument.createElement("input");
    return a.name = t.name, a.value = t.value, l.id && a.setAttribute("form", l.id), t.parentNode.insertBefore(a, t), l = new FormData(l), a.parentNode.removeChild(a), l;
  }
  function Mh(l, t, a, e, u) {
    if (t === "submit" && a && a.stateNode === u) {
      var n = Ko(
        (u[Kl] || null).action
      ), i = e.submitter;
      i && (t = (t = i[Kl] || null) ? Ko(t.formAction) : i.getAttribute("formAction"), t !== null && (n = t, i = null));
      var c = new Ku(
        "action",
        "action",
        null,
        e,
        u
      );
      l.push({
        event: c,
        listeners: [
          {
            instance: null,
            listener: function() {
              if (e.defaultPrevented) {
                if (ba !== 0) {
                  var s = i ? Jo(u, i) : new FormData(u);
                  vc(
                    a,
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
                typeof n == "function" && (c.preventDefault(), s = i ? Jo(u, i) : new FormData(u), vc(
                  a,
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
    Tt(
      Dh,
      "on" + Uh
    );
  }
  Tt(As, "onAnimationEnd"), Tt(Ts, "onAnimationIteration"), Tt(js, "onAnimationStart"), Tt("dblclick", "onDoubleClick"), Tt("focusin", "onFocus"), Tt("focusout", "onBlur"), Tt($r, "onTransitionRun"), Tt(Wr, "onTransitionStart"), Tt(kr, "onTransitionCancel"), Tt(Es, "onTransitionEnd"), le("onMouseEnter", ["mouseout", "mouseover"]), le("onMouseLeave", ["mouseout", "mouseover"]), le("onPointerEnter", ["pointerout", "pointerover"]), le("onPointerLeave", ["pointerout", "pointerover"]), Na(
    "onChange",
    "change click focusin focusout input keydown keyup selectionchange".split(" ")
  ), Na(
    "onSelect",
    "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(
      " "
    )
  ), Na("onBeforeInput", [
    "compositionend",
    "keypress",
    "textInput",
    "paste"
  ]), Na(
    "onCompositionEnd",
    "compositionend focusout keydown keypress keyup mousedown".split(" ")
  ), Na(
    "onCompositionStart",
    "compositionstart focusout keydown keypress keyup mousedown".split(" ")
  ), Na(
    "onCompositionUpdate",
    "compositionupdate focusout keydown keypress keyup mousedown".split(" ")
  );
  var bu = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
    " "
  ), Rh = new Set(
    "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(bu)
  );
  function wo(l, t) {
    t = (t & 4) !== 0;
    for (var a = 0; a < l.length; a++) {
      var e = l[a], u = e.event;
      e = e.listeners;
      l: {
        var n = void 0;
        if (t)
          for (var i = e.length - 1; 0 <= i; i--) {
            var c = e[i], s = c.instance, y = c.currentTarget;
            if (c = c.listener, s !== n && u.isPropagationStopped())
              break l;
            n = c, u.currentTarget = y;
            try {
              n(u);
            } catch (p) {
              $u(p);
            }
            u.currentTarget = null, n = s;
          }
        else
          for (i = 0; i < e.length; i++) {
            if (c = e[i], s = c.instance, y = c.currentTarget, c = c.listener, s !== n && u.isPropagationStopped())
              break l;
            n = c, u.currentTarget = y;
            try {
              n(u);
            } catch (p) {
              $u(p);
            }
            u.currentTarget = null, n = s;
          }
      }
    }
  }
  function W(l, t) {
    var a = t[di];
    a === void 0 && (a = t[di] = /* @__PURE__ */ new Set());
    var e = l + "__bubble";
    a.has(e) || ($o(t, l, 2, !1), a.add(e));
  }
  function Ic(l, t, a) {
    var e = 0;
    t && (e |= 4), $o(
      a,
      l,
      e,
      t
    );
  }
  var Hn = "_reactListening" + Math.random().toString(36).slice(2);
  function Pc(l) {
    if (!l[Hn]) {
      l[Hn] = !0, Qf.forEach(function(a) {
        a !== "selectionchange" && (Rh.has(a) || Ic(a, !1, l), Ic(a, !0, l));
      });
      var t = l.nodeType === 9 ? l : l.ownerDocument;
      t === null || t[Hn] || (t[Hn] = !0, Ic("selectionchange", !1, t));
    }
  }
  function $o(l, t, a, e) {
    switch (Tm(t)) {
      case 2:
        var u = cv;
        break;
      case 8:
        u = fv;
        break;
      default:
        u = vf;
    }
    a = u.bind(
      null,
      t,
      a,
      l
    ), u = void 0, !bi || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (u = !0), e ? u !== void 0 ? l.addEventListener(t, a, {
      capture: !0,
      passive: u
    }) : l.addEventListener(t, a, !0) : u !== void 0 ? l.addEventListener(t, a, {
      passive: u
    }) : l.addEventListener(t, a, !1);
  }
  function lf(l, t, a, e, u) {
    var n = e;
    if ((t & 1) === 0 && (t & 2) === 0 && e !== null)
      l: for (; ; ) {
        if (e === null) return;
        var i = e.tag;
        if (i === 3 || i === 4) {
          var c = e.stateNode.containerInfo;
          if (c === u) break;
          if (i === 4)
            for (i = e.return; i !== null; ) {
              var s = i.tag;
              if ((s === 3 || s === 4) && i.stateNode.containerInfo === u)
                return;
              i = i.return;
            }
          for (; c !== null; ) {
            if (i = Fa(c), i === null) return;
            if (s = i.tag, s === 5 || s === 6 || s === 26 || s === 27) {
              e = n = i;
              continue l;
            }
            c = c.parentNode;
          }
        }
        e = e.return;
      }
    If(function() {
      var y = n, p = gi(a), j = [];
      l: {
        var g = xs.get(l);
        if (g !== void 0) {
          var S = Ku, R = l;
          switch (l) {
            case "keypress":
              if (Zu(a) === 0) break l;
            case "keydown":
            case "keyup":
              S = xr;
              break;
            case "focusin":
              R = "focus", S = Ti;
              break;
            case "focusout":
              R = "blur", S = Ti;
              break;
            case "beforeblur":
            case "afterblur":
              S = Ti;
              break;
            case "click":
              if (a.button === 2) break l;
            case "auxclick":
            case "dblclick":
            case "mousedown":
            case "mousemove":
            case "mouseup":
            case "mouseout":
            case "mouseover":
            case "contextmenu":
              S = ts;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              S = hr;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              S = Nr;
              break;
            case As:
            case Ts:
            case js:
              S = gr;
              break;
            case Es:
              S = Dr;
              break;
            case "scroll":
            case "scrollend":
              S = mr;
              break;
            case "wheel":
              S = Rr;
              break;
            case "copy":
            case "cut":
            case "paste":
              S = br;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              S = es;
              break;
            case "toggle":
            case "beforetoggle":
              S = Hr;
          }
          var G = (t & 4) !== 0, ml = !G && (l === "scroll" || l === "scrollend"), h = G ? g !== null ? g + "Capture" : null : g;
          G = [];
          for (var d = y, v; d !== null; ) {
            var T = d;
            if (v = T.stateNode, T = T.tag, T !== 5 && T !== 26 && T !== 27 || v === null || h === null || (T = Xe(d, h), T != null && G.push(
              pu(d, T, v)
            )), ml) break;
            d = d.return;
          }
          0 < G.length && (g = new S(
            g,
            R,
            null,
            a,
            p
          ), j.push({ event: g, listeners: G }));
        }
      }
      if ((t & 7) === 0) {
        l: {
          if (g = l === "mouseover" || l === "pointerover", S = l === "mouseout" || l === "pointerout", g && a !== yi && (R = a.relatedTarget || a.fromElement) && (Fa(R) || R[ka]))
            break l;
          if ((S || g) && (g = p.window === p ? p : (g = p.ownerDocument) ? g.defaultView || g.parentWindow : window, S ? (R = a.relatedTarget || a.toElement, S = y, R = R ? Fa(R) : null, R !== null && (ml = C(R), G = R.tag, R !== ml || G !== 5 && G !== 27 && G !== 6) && (R = null)) : (S = null, R = y), S !== R)) {
            if (G = ts, T = "onMouseLeave", h = "onMouseEnter", d = "mouse", (l === "pointerout" || l === "pointerover") && (G = es, T = "onPointerLeave", h = "onPointerEnter", d = "pointer"), ml = S == null ? g : Qe(S), v = R == null ? g : Qe(R), g = new G(
              T,
              d + "leave",
              S,
              a,
              p
            ), g.target = ml, g.relatedTarget = v, T = null, Fa(p) === y && (G = new G(
              h,
              d + "enter",
              R,
              a,
              p
            ), G.target = v, G.relatedTarget = ml, T = G), ml = T, S && R)
              t: {
                for (G = Ch, h = S, d = R, v = 0, T = h; T; T = G(T))
                  v++;
                T = 0;
                for (var Y = d; Y; Y = G(Y))
                  T++;
                for (; 0 < v - T; )
                  h = G(h), v--;
                for (; 0 < T - v; )
                  d = G(d), T--;
                for (; v--; ) {
                  if (h === d || d !== null && h === d.alternate) {
                    G = h;
                    break t;
                  }
                  h = G(h), d = G(d);
                }
                G = null;
              }
            else G = null;
            S !== null && Wo(
              j,
              g,
              S,
              G,
              !1
            ), R !== null && ml !== null && Wo(
              j,
              ml,
              R,
              G,
              !0
            );
          }
        }
        l: {
          if (g = y ? Qe(y) : window, S = g.nodeName && g.nodeName.toLowerCase(), S === "select" || S === "input" && g.type === "file")
            var al = os;
          else if (ss(g))
            if (ms)
              al = Kr;
            else {
              al = Zr;
              var B = Lr;
            }
          else
            S = g.nodeName, !S || S.toLowerCase() !== "input" || g.type !== "checkbox" && g.type !== "radio" ? y && vi(y.elementType) && (al = os) : al = Vr;
          if (al && (al = al(l, y))) {
            ds(
              j,
              al,
              a,
              p
            );
            break l;
          }
          B && B(l, g, y), l === "focusout" && y && g.type === "number" && y.memoizedProps.value != null && hi(g, "number", g.value);
        }
        switch (B = y ? Qe(y) : window, l) {
          case "focusin":
            (ss(B) || B.contentEditable === "true") && (ie = B, Ni = y, We = null);
            break;
          case "focusout":
            We = Ni = ie = null;
            break;
          case "mousedown":
            Mi = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            Mi = !1, ps(j, a, p);
            break;
          case "selectionchange":
            if (wr) break;
          case "keydown":
          case "keyup":
            ps(j, a, p);
        }
        var J;
        if (Ei)
          l: {
            switch (l) {
              case "compositionstart":
                var F = "onCompositionStart";
                break l;
              case "compositionend":
                F = "onCompositionEnd";
                break l;
              case "compositionupdate":
                F = "onCompositionUpdate";
                break l;
            }
            F = void 0;
          }
        else
          ne ? cs(l, a) && (F = "onCompositionEnd") : l === "keydown" && a.keyCode === 229 && (F = "onCompositionStart");
        F && (us && a.locale !== "ko" && (ne || F !== "onCompositionStart" ? F === "onCompositionEnd" && ne && (J = Pf()) : (ea = p, pi = "value" in ea ? ea.value : ea.textContent, ne = !0)), B = qn(y, F), 0 < B.length && (F = new as(
          F,
          l,
          null,
          a,
          p
        ), j.push({ event: F, listeners: B }), J ? F.data = J : (J = fs(a), J !== null && (F.data = J)))), (J = Br ? Yr(l, a) : Gr(l, a)) && (F = qn(y, "onBeforeInput"), 0 < F.length && (B = new as(
          "onBeforeInput",
          "beforeinput",
          null,
          a,
          p
        ), j.push({
          event: B,
          listeners: F
        }), B.data = J)), Mh(
          j,
          l,
          y,
          a,
          p
        );
      }
      wo(j, t);
    });
  }
  function pu(l, t, a) {
    return {
      instance: l,
      listener: t,
      currentTarget: a
    };
  }
  function qn(l, t) {
    for (var a = t + "Capture", e = []; l !== null; ) {
      var u = l, n = u.stateNode;
      if (u = u.tag, u !== 5 && u !== 26 && u !== 27 || n === null || (u = Xe(l, a), u != null && e.unshift(
        pu(l, u, n)
      ), u = Xe(l, t), u != null && e.push(
        pu(l, u, n)
      )), l.tag === 3) return e;
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
  function Wo(l, t, a, e, u) {
    for (var n = t._reactName, i = []; a !== null && a !== e; ) {
      var c = a, s = c.alternate, y = c.stateNode;
      if (c = c.tag, s !== null && s === e) break;
      c !== 5 && c !== 26 && c !== 27 || y === null || (s = y, u ? (y = Xe(a, n), y != null && i.unshift(
        pu(a, y, s)
      )) : u || (y = Xe(a, n), y != null && i.push(
        pu(a, y, s)
      ))), a = a.return;
    }
    i.length !== 0 && l.push({ event: t, listeners: i });
  }
  var Hh = /\r\n?/g, qh = /\u0000|\uFFFD/g;
  function ko(l) {
    return (typeof l == "string" ? l : "" + l).replace(Hh, `
`).replace(qh, "");
  }
  function Fo(l, t) {
    return t = ko(t), ko(l) === t;
  }
  function ol(l, t, a, e, u, n) {
    switch (a) {
      case "children":
        typeof e == "string" ? t === "body" || t === "textarea" && e === "" || ae(l, e) : (typeof e == "number" || typeof e == "bigint") && t !== "body" && ae(l, "" + e);
        break;
      case "className":
        Gu(l, "class", e);
        break;
      case "tabIndex":
        Gu(l, "tabindex", e);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        Gu(l, a, e);
        break;
      case "style":
        kf(l, e, n);
        break;
      case "data":
        if (t !== "object") {
          Gu(l, "data", e);
          break;
        }
      case "src":
      case "href":
        if (e === "" && (t !== "a" || a !== "href")) {
          l.removeAttribute(a);
          break;
        }
        if (e == null || typeof e == "function" || typeof e == "symbol" || typeof e == "boolean") {
          l.removeAttribute(a);
          break;
        }
        e = Xu("" + e), l.setAttribute(a, e);
        break;
      case "action":
      case "formAction":
        if (typeof e == "function") {
          l.setAttribute(
            a,
            "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')"
          );
          break;
        } else
          typeof n == "function" && (a === "formAction" ? (t !== "input" && ol(l, t, "name", u.name, u, null), ol(
            l,
            t,
            "formEncType",
            u.formEncType,
            u,
            null
          ), ol(
            l,
            t,
            "formMethod",
            u.formMethod,
            u,
            null
          ), ol(
            l,
            t,
            "formTarget",
            u.formTarget,
            u,
            null
          )) : (ol(l, t, "encType", u.encType, u, null), ol(l, t, "method", u.method, u, null), ol(l, t, "target", u.target, u, null)));
        if (e == null || typeof e == "symbol" || typeof e == "boolean") {
          l.removeAttribute(a);
          break;
        }
        e = Xu("" + e), l.setAttribute(a, e);
        break;
      case "onClick":
        e != null && (l.onclick = Ht);
        break;
      case "onScroll":
        e != null && W("scroll", l);
        break;
      case "onScrollEnd":
        e != null && W("scrollend", l);
        break;
      case "dangerouslySetInnerHTML":
        if (e != null) {
          if (typeof e != "object" || !("__html" in e))
            throw Error(o(61));
          if (a = e.__html, a != null) {
            if (u.children != null) throw Error(o(60));
            l.innerHTML = a;
          }
        }
        break;
      case "multiple":
        l.multiple = e && typeof e != "function" && typeof e != "symbol";
        break;
      case "muted":
        l.muted = e && typeof e != "function" && typeof e != "symbol";
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
        if (e == null || typeof e == "function" || typeof e == "boolean" || typeof e == "symbol") {
          l.removeAttribute("xlink:href");
          break;
        }
        a = Xu("" + e), l.setAttributeNS(
          "http://www.w3.org/1999/xlink",
          "xlink:href",
          a
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
        e != null && typeof e != "function" && typeof e != "symbol" ? l.setAttribute(a, "" + e) : l.removeAttribute(a);
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
        e && typeof e != "function" && typeof e != "symbol" ? l.setAttribute(a, "") : l.removeAttribute(a);
        break;
      case "capture":
      case "download":
        e === !0 ? l.setAttribute(a, "") : e !== !1 && e != null && typeof e != "function" && typeof e != "symbol" ? l.setAttribute(a, e) : l.removeAttribute(a);
        break;
      case "cols":
      case "rows":
      case "size":
      case "span":
        e != null && typeof e != "function" && typeof e != "symbol" && !isNaN(e) && 1 <= e ? l.setAttribute(a, e) : l.removeAttribute(a);
        break;
      case "rowSpan":
      case "start":
        e == null || typeof e == "function" || typeof e == "symbol" || isNaN(e) ? l.removeAttribute(a) : l.setAttribute(a, e);
        break;
      case "popover":
        W("beforetoggle", l), W("toggle", l), Yu(l, "popover", e);
        break;
      case "xlinkActuate":
        Ct(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:actuate",
          e
        );
        break;
      case "xlinkArcrole":
        Ct(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:arcrole",
          e
        );
        break;
      case "xlinkRole":
        Ct(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:role",
          e
        );
        break;
      case "xlinkShow":
        Ct(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:show",
          e
        );
        break;
      case "xlinkTitle":
        Ct(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:title",
          e
        );
        break;
      case "xlinkType":
        Ct(
          l,
          "http://www.w3.org/1999/xlink",
          "xlink:type",
          e
        );
        break;
      case "xmlBase":
        Ct(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:base",
          e
        );
        break;
      case "xmlLang":
        Ct(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:lang",
          e
        );
        break;
      case "xmlSpace":
        Ct(
          l,
          "http://www.w3.org/XML/1998/namespace",
          "xml:space",
          e
        );
        break;
      case "is":
        Yu(l, "is", e);
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        (!(2 < a.length) || a[0] !== "o" && a[0] !== "O" || a[1] !== "n" && a[1] !== "N") && (a = dr.get(a) || a, Yu(l, a, e));
    }
  }
  function tf(l, t, a, e, u, n) {
    switch (a) {
      case "style":
        kf(l, e, n);
        break;
      case "dangerouslySetInnerHTML":
        if (e != null) {
          if (typeof e != "object" || !("__html" in e))
            throw Error(o(61));
          if (a = e.__html, a != null) {
            if (u.children != null) throw Error(o(60));
            l.innerHTML = a;
          }
        }
        break;
      case "children":
        typeof e == "string" ? ae(l, e) : (typeof e == "number" || typeof e == "bigint") && ae(l, "" + e);
        break;
      case "onScroll":
        e != null && W("scroll", l);
        break;
      case "onScrollEnd":
        e != null && W("scrollend", l);
        break;
      case "onClick":
        e != null && (l.onclick = Ht);
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
        if (!Xf.hasOwnProperty(a))
          l: {
            if (a[0] === "o" && a[1] === "n" && (u = a.endsWith("Capture"), t = a.slice(2, u ? a.length - 7 : void 0), n = l[Kl] || null, n = n != null ? n[a] : null, typeof n == "function" && l.removeEventListener(t, n, u), typeof e == "function")) {
              typeof n != "function" && n !== null && (a in l ? l[a] = null : l.hasAttribute(a) && l.removeAttribute(a)), l.addEventListener(t, e, u);
              break l;
            }
            a in l ? l[a] = e : e === !0 ? l.setAttribute(a, "") : Yu(l, a, e);
          }
    }
  }
  function ql(l, t, a) {
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
        W("error", l), W("load", l);
        var e = !1, u = !1, n;
        for (n in a)
          if (a.hasOwnProperty(n)) {
            var i = a[n];
            if (i != null)
              switch (n) {
                case "src":
                  e = !0;
                  break;
                case "srcSet":
                  u = !0;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(o(137, t));
                default:
                  ol(l, t, n, i, a, null);
              }
          }
        u && ol(l, t, "srcSet", a.srcSet, a, null), e && ol(l, t, "src", a.src, a, null);
        return;
      case "input":
        W("invalid", l);
        var c = n = i = u = null, s = null, y = null;
        for (e in a)
          if (a.hasOwnProperty(e)) {
            var p = a[e];
            if (p != null)
              switch (e) {
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
                  y = p;
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
                    throw Error(o(137, t));
                  break;
                default:
                  ol(l, t, e, p, a, null);
              }
          }
        Jf(
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
        W("invalid", l), e = i = n = null;
        for (u in a)
          if (a.hasOwnProperty(u) && (c = a[u], c != null))
            switch (u) {
              case "value":
                n = c;
                break;
              case "defaultValue":
                i = c;
                break;
              case "multiple":
                e = c;
              default:
                ol(l, t, u, c, a, null);
            }
        t = n, a = i, l.multiple = !!e, t != null ? te(l, !!e, t, !1) : a != null && te(l, !!e, a, !0);
        return;
      case "textarea":
        W("invalid", l), n = u = e = null;
        for (i in a)
          if (a.hasOwnProperty(i) && (c = a[i], c != null))
            switch (i) {
              case "value":
                e = c;
                break;
              case "defaultValue":
                u = c;
                break;
              case "children":
                n = c;
                break;
              case "dangerouslySetInnerHTML":
                if (c != null) throw Error(o(91));
                break;
              default:
                ol(l, t, i, c, a, null);
            }
        $f(l, e, u, n);
        return;
      case "option":
        for (s in a)
          a.hasOwnProperty(s) && (e = a[s], e != null) && (s === "selected" ? l.selected = e && typeof e != "function" && typeof e != "symbol" : ol(l, t, s, e, a, null));
        return;
      case "dialog":
        W("beforetoggle", l), W("toggle", l), W("cancel", l), W("close", l);
        break;
      case "iframe":
      case "object":
        W("load", l);
        break;
      case "video":
      case "audio":
        for (e = 0; e < bu.length; e++)
          W(bu[e], l);
        break;
      case "image":
        W("error", l), W("load", l);
        break;
      case "details":
        W("toggle", l);
        break;
      case "embed":
      case "source":
      case "link":
        W("error", l), W("load", l);
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
        for (y in a)
          if (a.hasOwnProperty(y) && (e = a[y], e != null))
            switch (y) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(o(137, t));
              default:
                ol(l, t, y, e, a, null);
            }
        return;
      default:
        if (vi(t)) {
          for (p in a)
            a.hasOwnProperty(p) && (e = a[p], e !== void 0 && tf(
              l,
              t,
              p,
              e,
              a,
              void 0
            ));
          return;
        }
    }
    for (c in a)
      a.hasOwnProperty(c) && (e = a[c], e != null && ol(l, t, c, e, a, null));
  }
  function Bh(l, t, a, e) {
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
        var u = null, n = null, i = null, c = null, s = null, y = null, p = null;
        for (S in a) {
          var j = a[S];
          if (a.hasOwnProperty(S) && j != null)
            switch (S) {
              case "checked":
                break;
              case "value":
                break;
              case "defaultValue":
                s = j;
              default:
                e.hasOwnProperty(S) || ol(l, t, S, null, e, j);
            }
        }
        for (var g in e) {
          var S = e[g];
          if (j = a[g], e.hasOwnProperty(g) && (S != null || j != null))
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
                p = S;
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
                  throw Error(o(137, t));
                break;
              default:
                S !== j && ol(
                  l,
                  t,
                  g,
                  S,
                  e,
                  j
                );
            }
        }
        ri(
          l,
          i,
          c,
          s,
          y,
          p,
          n,
          u
        );
        return;
      case "select":
        S = i = c = g = null;
        for (n in a)
          if (s = a[n], a.hasOwnProperty(n) && s != null)
            switch (n) {
              case "value":
                break;
              case "multiple":
                S = s;
              default:
                e.hasOwnProperty(n) || ol(
                  l,
                  t,
                  n,
                  null,
                  e,
                  s
                );
            }
        for (u in e)
          if (n = e[u], s = a[u], e.hasOwnProperty(u) && (n != null || s != null))
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
                n !== s && ol(
                  l,
                  t,
                  u,
                  n,
                  e,
                  s
                );
            }
        t = c, a = i, e = S, g != null ? te(l, !!a, g, !1) : !!e != !!a && (t != null ? te(l, !!a, t, !0) : te(l, !!a, a ? [] : "", !1));
        return;
      case "textarea":
        S = g = null;
        for (c in a)
          if (u = a[c], a.hasOwnProperty(c) && u != null && !e.hasOwnProperty(c))
            switch (c) {
              case "value":
                break;
              case "children":
                break;
              default:
                ol(l, t, c, null, e, u);
            }
        for (i in e)
          if (u = e[i], n = a[i], e.hasOwnProperty(i) && (u != null || n != null))
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
                u !== n && ol(l, t, i, u, e, n);
            }
        wf(l, g, S);
        return;
      case "option":
        for (var R in a)
          g = a[R], a.hasOwnProperty(R) && g != null && !e.hasOwnProperty(R) && (R === "selected" ? l.selected = !1 : ol(
            l,
            t,
            R,
            null,
            e,
            g
          ));
        for (s in e)
          g = e[s], S = a[s], e.hasOwnProperty(s) && g !== S && (g != null || S != null) && (s === "selected" ? l.selected = g && typeof g != "function" && typeof g != "symbol" : ol(
            l,
            t,
            s,
            g,
            e,
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
        for (var G in a)
          g = a[G], a.hasOwnProperty(G) && g != null && !e.hasOwnProperty(G) && ol(l, t, G, null, e, g);
        for (y in e)
          if (g = e[y], S = a[y], e.hasOwnProperty(y) && g !== S && (g != null || S != null))
            switch (y) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (g != null)
                  throw Error(o(137, t));
                break;
              default:
                ol(
                  l,
                  t,
                  y,
                  g,
                  e,
                  S
                );
            }
        return;
      default:
        if (vi(t)) {
          for (var ml in a)
            g = a[ml], a.hasOwnProperty(ml) && g !== void 0 && !e.hasOwnProperty(ml) && tf(
              l,
              t,
              ml,
              void 0,
              e,
              g
            );
          for (p in e)
            g = e[p], S = a[p], !e.hasOwnProperty(p) || g === S || g === void 0 && S === void 0 || tf(
              l,
              t,
              p,
              g,
              e,
              S
            );
          return;
        }
    }
    for (var h in a)
      g = a[h], a.hasOwnProperty(h) && g != null && !e.hasOwnProperty(h) && ol(l, t, h, null, e, g);
    for (j in e)
      g = e[j], S = a[j], !e.hasOwnProperty(j) || g === S || g == null && S == null || ol(l, t, j, g, e, S);
  }
  function Io(l) {
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
      for (var l = 0, t = 0, a = performance.getEntriesByType("resource"), e = 0; e < a.length; e++) {
        var u = a[e], n = u.transferSize, i = u.initiatorType, c = u.duration;
        if (n && c && Io(i)) {
          for (i = 0, c = u.responseEnd, e += 1; e < a.length; e++) {
            var s = a[e], y = s.startTime;
            if (y > c) break;
            var p = s.transferSize, j = s.initiatorType;
            p && Io(j) && (s = s.responseEnd, i += p * (s < c ? 1 : (c - y) / (s - y)));
          }
          if (--e, t += 8 * (n + i) / (u.duration / 1e3), l++, 10 < l) break;
        }
      }
      if (0 < l) return t / l / 1e6;
    }
    return navigator.connection && (l = navigator.connection.downlink, typeof l == "number") ? l : 5;
  }
  var af = null, ef = null;
  function Bn(l) {
    return l.nodeType === 9 ? l : l.ownerDocument;
  }
  function Po(l) {
    switch (l) {
      case "http://www.w3.org/2000/svg":
        return 1;
      case "http://www.w3.org/1998/Math/MathML":
        return 2;
      default:
        return 0;
    }
  }
  function lm(l, t) {
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
  var tm = typeof setTimeout == "function" ? setTimeout : void 0, Qh = typeof clearTimeout == "function" ? clearTimeout : void 0, am = typeof Promise == "function" ? Promise : void 0, Xh = typeof queueMicrotask == "function" ? queueMicrotask : typeof am < "u" ? function(l) {
    return am.resolve(null).then(l).catch(Lh);
  } : tm;
  function Lh(l) {
    setTimeout(function() {
      throw l;
    });
  }
  function pa(l) {
    return l === "head";
  }
  function em(l, t) {
    var a = t, e = 0;
    do {
      var u = a.nextSibling;
      if (l.removeChild(a), u && u.nodeType === 8)
        if (a = u.data, a === "/$" || a === "/&") {
          if (e === 0) {
            l.removeChild(u), Re(t);
            return;
          }
          e--;
        } else if (a === "$" || a === "$?" || a === "$~" || a === "$!" || a === "&")
          e++;
        else if (a === "html")
          zu(l.ownerDocument.documentElement);
        else if (a === "head") {
          a = l.ownerDocument.head, zu(a);
          for (var n = a.firstChild; n; ) {
            var i = n.nextSibling, c = n.nodeName;
            n[Ge] || c === "SCRIPT" || c === "STYLE" || c === "LINK" && n.rel.toLowerCase() === "stylesheet" || a.removeChild(n), n = i;
          }
        } else
          a === "body" && zu(l.ownerDocument.body);
      a = u;
    } while (a);
    Re(t);
  }
  function um(l, t) {
    var a = l;
    l = 0;
    do {
      var e = a.nextSibling;
      if (a.nodeType === 1 ? t ? (a._stashedDisplay = a.style.display, a.style.display = "none") : (a.style.display = a._stashedDisplay || "", a.getAttribute("style") === "" && a.removeAttribute("style")) : a.nodeType === 3 && (t ? (a._stashedText = a.nodeValue, a.nodeValue = "") : a.nodeValue = a._stashedText || ""), e && e.nodeType === 8)
        if (a = e.data, a === "/$") {
          if (l === 0) break;
          l--;
        } else
          a !== "$" && a !== "$?" && a !== "$~" && a !== "$!" || l++;
      a = e;
    } while (a);
  }
  function cf(l) {
    var t = l.firstChild;
    for (t && t.nodeType === 10 && (t = t.nextSibling); t; ) {
      var a = t;
      switch (t = t.nextSibling, a.nodeName) {
        case "HTML":
        case "HEAD":
        case "BODY":
          cf(a), oi(a);
          continue;
        case "SCRIPT":
        case "STYLE":
          continue;
        case "LINK":
          if (a.rel.toLowerCase() === "stylesheet") continue;
      }
      l.removeChild(a);
    }
  }
  function Zh(l, t, a, e) {
    for (; l.nodeType === 1; ) {
      var u = a;
      if (l.nodeName.toLowerCase() !== t.toLowerCase()) {
        if (!e && (l.nodeName !== "INPUT" || l.type !== "hidden"))
          break;
      } else if (e) {
        if (!l[Ge])
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
      if (l = pt(l.nextSibling), l === null) break;
    }
    return null;
  }
  function Vh(l, t, a) {
    if (t === "") return null;
    for (; l.nodeType !== 3; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !a || (l = pt(l.nextSibling), l === null)) return null;
    return l;
  }
  function nm(l, t) {
    for (; l.nodeType !== 8; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !t || (l = pt(l.nextSibling), l === null)) return null;
    return l;
  }
  function ff(l) {
    return l.data === "$?" || l.data === "$~";
  }
  function sf(l) {
    return l.data === "$!" || l.data === "$?" && l.ownerDocument.readyState !== "loading";
  }
  function Kh(l, t) {
    var a = l.ownerDocument;
    if (l.data === "$~") l._reactRetry = t;
    else if (l.data !== "$?" || a.readyState !== "loading")
      t();
    else {
      var e = function() {
        t(), a.removeEventListener("DOMContentLoaded", e);
      };
      a.addEventListener("DOMContentLoaded", e), l._reactRetry = e;
    }
  }
  function pt(l) {
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
  function im(l) {
    l = l.nextSibling;
    for (var t = 0; l; ) {
      if (l.nodeType === 8) {
        var a = l.data;
        if (a === "/$" || a === "/&") {
          if (t === 0)
            return pt(l.nextSibling);
          t--;
        } else
          a !== "$" && a !== "$!" && a !== "$?" && a !== "$~" && a !== "&" || t++;
      }
      l = l.nextSibling;
    }
    return null;
  }
  function cm(l) {
    l = l.previousSibling;
    for (var t = 0; l; ) {
      if (l.nodeType === 8) {
        var a = l.data;
        if (a === "$" || a === "$!" || a === "$?" || a === "$~" || a === "&") {
          if (t === 0) return l;
          t--;
        } else a !== "/$" && a !== "/&" || t++;
      }
      l = l.previousSibling;
    }
    return null;
  }
  function fm(l, t, a) {
    switch (t = Bn(a), l) {
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
  function zu(l) {
    for (var t = l.attributes; t.length; )
      l.removeAttributeNode(t[0]);
    oi(l);
  }
  var zt = /* @__PURE__ */ new Map(), sm = /* @__PURE__ */ new Set();
  function Yn(l) {
    return typeof l.getRootNode == "function" ? l.getRootNode() : l.nodeType === 9 ? l : l.ownerDocument;
  }
  var Ft = D.d;
  D.d = {
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
    var l = Ft.f(), t = Nn();
    return l || t;
  }
  function wh(l) {
    var t = Ia(l);
    t !== null && t.tag === 5 && t.type === "form" ? Ed(t) : Ft.r(l);
  }
  var Me = typeof document > "u" ? null : document;
  function dm(l, t, a) {
    var e = Me;
    if (e && typeof t == "string" && t) {
      var u = rt(t);
      u = 'link[rel="' + l + '"][href="' + u + '"]', typeof a == "string" && (u += '[crossorigin="' + a + '"]'), sm.has(u) || (sm.add(u), l = { rel: l, crossOrigin: a, href: t }, e.querySelector(u) === null && (t = e.createElement("link"), ql(t, "link", l), Ml(t), e.head.appendChild(t)));
    }
  }
  function $h(l) {
    Ft.D(l), dm("dns-prefetch", l, null);
  }
  function Wh(l, t) {
    Ft.C(l, t), dm("preconnect", l, t);
  }
  function kh(l, t, a) {
    Ft.L(l, t, a);
    var e = Me;
    if (e && l && t) {
      var u = 'link[rel="preload"][as="' + rt(t) + '"]';
      t === "image" && a && a.imageSrcSet ? (u += '[imagesrcset="' + rt(
        a.imageSrcSet
      ) + '"]', typeof a.imageSizes == "string" && (u += '[imagesizes="' + rt(
        a.imageSizes
      ) + '"]')) : u += '[href="' + rt(l) + '"]';
      var n = u;
      switch (t) {
        case "style":
          n = De(l);
          break;
        case "script":
          n = Ue(l);
      }
      zt.has(n) || (l = A(
        {
          rel: "preload",
          href: t === "image" && a && a.imageSrcSet ? void 0 : l,
          as: t
        },
        a
      ), zt.set(n, l), e.querySelector(u) !== null || t === "style" && e.querySelector(Au(n)) || t === "script" && e.querySelector(Tu(n)) || (t = e.createElement("link"), ql(t, "link", l), Ml(t), e.head.appendChild(t)));
    }
  }
  function Fh(l, t) {
    Ft.m(l, t);
    var a = Me;
    if (a && l) {
      var e = t && typeof t.as == "string" ? t.as : "script", u = 'link[rel="modulepreload"][as="' + rt(e) + '"][href="' + rt(l) + '"]', n = u;
      switch (e) {
        case "audioworklet":
        case "paintworklet":
        case "serviceworker":
        case "sharedworker":
        case "worker":
        case "script":
          n = Ue(l);
      }
      if (!zt.has(n) && (l = A({ rel: "modulepreload", href: l }, t), zt.set(n, l), a.querySelector(u) === null)) {
        switch (e) {
          case "audioworklet":
          case "paintworklet":
          case "serviceworker":
          case "sharedworker":
          case "worker":
          case "script":
            if (a.querySelector(Tu(n)))
              return;
        }
        e = a.createElement("link"), ql(e, "link", l), Ml(e), a.head.appendChild(e);
      }
    }
  }
  function Ih(l, t, a) {
    Ft.S(l, t, a);
    var e = Me;
    if (e && l) {
      var u = Pa(e).hoistableStyles, n = De(l);
      t = t || "default";
      var i = u.get(n);
      if (!i) {
        var c = { loading: 0, preload: null };
        if (i = e.querySelector(
          Au(n)
        ))
          c.loading = 5;
        else {
          l = A(
            { rel: "stylesheet", href: l, "data-precedence": t },
            a
          ), (a = zt.get(n)) && of(l, a);
          var s = i = e.createElement("link");
          Ml(s), ql(s, "link", l), s._p = new Promise(function(y, p) {
            s.onload = y, s.onerror = p;
          }), s.addEventListener("load", function() {
            c.loading |= 1;
          }), s.addEventListener("error", function() {
            c.loading |= 2;
          }), c.loading |= 4, Gn(i, t, e);
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
    Ft.X(l, t);
    var a = Me;
    if (a && l) {
      var e = Pa(a).hoistableScripts, u = Ue(l), n = e.get(u);
      n || (n = a.querySelector(Tu(u)), n || (l = A({ src: l, async: !0 }, t), (t = zt.get(u)) && mf(l, t), n = a.createElement("script"), Ml(n), ql(n, "link", l), a.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, e.set(u, n));
    }
  }
  function lv(l, t) {
    Ft.M(l, t);
    var a = Me;
    if (a && l) {
      var e = Pa(a).hoistableScripts, u = Ue(l), n = e.get(u);
      n || (n = a.querySelector(Tu(u)), n || (l = A({ src: l, async: !0, type: "module" }, t), (t = zt.get(u)) && mf(l, t), n = a.createElement("script"), Ml(n), ql(n, "link", l), a.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, e.set(u, n));
    }
  }
  function om(l, t, a, e) {
    var u = (u = w.current) ? Yn(u) : null;
    if (!u) throw Error(o(446));
    switch (l) {
      case "meta":
      case "title":
        return null;
      case "style":
        return typeof a.precedence == "string" && typeof a.href == "string" ? (t = De(a.href), a = Pa(
          u
        ).hoistableStyles, e = a.get(t), e || (e = {
          type: "style",
          instance: null,
          count: 0,
          state: null
        }, a.set(t, e)), e) : { type: "void", instance: null, count: 0, state: null };
      case "link":
        if (a.rel === "stylesheet" && typeof a.href == "string" && typeof a.precedence == "string") {
          l = De(a.href);
          var n = Pa(
            u
          ).hoistableStyles, i = n.get(l);
          if (i || (u = u.ownerDocument || u, i = {
            type: "stylesheet",
            instance: null,
            count: 0,
            state: { loading: 0, preload: null }
          }, n.set(l, i), (n = u.querySelector(
            Au(l)
          )) && !n._p && (i.instance = n, i.state.loading = 5), zt.has(l) || (a = {
            rel: "preload",
            as: "style",
            href: a.href,
            crossOrigin: a.crossOrigin,
            integrity: a.integrity,
            media: a.media,
            hrefLang: a.hrefLang,
            referrerPolicy: a.referrerPolicy
          }, zt.set(l, a), n || tv(
            u,
            l,
            a,
            i.state
          ))), t && e === null)
            throw Error(o(528, ""));
          return i;
        }
        if (t && e !== null)
          throw Error(o(529, ""));
        return null;
      case "script":
        return t = a.async, a = a.src, typeof a == "string" && t && typeof t != "function" && typeof t != "symbol" ? (t = Ue(a), a = Pa(
          u
        ).hoistableScripts, e = a.get(t), e || (e = {
          type: "script",
          instance: null,
          count: 0,
          state: null
        }, a.set(t, e)), e) : { type: "void", instance: null, count: 0, state: null };
      default:
        throw Error(o(444, l));
    }
  }
  function De(l) {
    return 'href="' + rt(l) + '"';
  }
  function Au(l) {
    return 'link[rel="stylesheet"][' + l + "]";
  }
  function mm(l) {
    return A({}, l, {
      "data-precedence": l.precedence,
      precedence: null
    });
  }
  function tv(l, t, a, e) {
    l.querySelector('link[rel="preload"][as="style"][' + t + "]") ? e.loading = 1 : (t = l.createElement("link"), e.preload = t, t.addEventListener("load", function() {
      return e.loading |= 1;
    }), t.addEventListener("error", function() {
      return e.loading |= 2;
    }), ql(t, "link", a), Ml(t), l.head.appendChild(t));
  }
  function Ue(l) {
    return '[src="' + rt(l) + '"]';
  }
  function Tu(l) {
    return "script[async]" + l;
  }
  function rm(l, t, a) {
    if (t.count++, t.instance === null)
      switch (t.type) {
        case "style":
          var e = l.querySelector(
            'style[data-href~="' + rt(a.href) + '"]'
          );
          if (e)
            return t.instance = e, Ml(e), e;
          var u = A({}, a, {
            "data-href": a.href,
            "data-precedence": a.precedence,
            href: null,
            precedence: null
          });
          return e = (l.ownerDocument || l).createElement(
            "style"
          ), Ml(e), ql(e, "style", u), Gn(e, a.precedence, l), t.instance = e;
        case "stylesheet":
          u = De(a.href);
          var n = l.querySelector(
            Au(u)
          );
          if (n)
            return t.state.loading |= 4, t.instance = n, Ml(n), n;
          e = mm(a), (u = zt.get(u)) && of(e, u), n = (l.ownerDocument || l).createElement("link"), Ml(n);
          var i = n;
          return i._p = new Promise(function(c, s) {
            i.onload = c, i.onerror = s;
          }), ql(n, "link", e), t.state.loading |= 4, Gn(n, a.precedence, l), t.instance = n;
        case "script":
          return n = Ue(a.src), (u = l.querySelector(
            Tu(n)
          )) ? (t.instance = u, Ml(u), u) : (e = a, (u = zt.get(n)) && (e = A({}, a), mf(e, u)), l = l.ownerDocument || l, u = l.createElement("script"), Ml(u), ql(u, "link", e), l.head.appendChild(u), t.instance = u);
        case "void":
          return null;
        default:
          throw Error(o(443, t.type));
      }
    else
      t.type === "stylesheet" && (t.state.loading & 4) === 0 && (e = t.instance, t.state.loading |= 4, Gn(e, a.precedence, l));
    return t.instance;
  }
  function Gn(l, t, a) {
    for (var e = a.querySelectorAll(
      'link[rel="stylesheet"][data-precedence],style[data-precedence]'
    ), u = e.length ? e[e.length - 1] : null, n = u, i = 0; i < e.length; i++) {
      var c = e[i];
      if (c.dataset.precedence === t) n = c;
      else if (n !== u) break;
    }
    n ? n.parentNode.insertBefore(l, n.nextSibling) : (t = a.nodeType === 9 ? a.head : a, t.insertBefore(l, t.firstChild));
  }
  function of(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.title == null && (l.title = t.title);
  }
  function mf(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.integrity == null && (l.integrity = t.integrity);
  }
  var Qn = null;
  function hm(l, t, a) {
    if (Qn === null) {
      var e = /* @__PURE__ */ new Map(), u = Qn = /* @__PURE__ */ new Map();
      u.set(a, e);
    } else
      u = Qn, e = u.get(a), e || (e = /* @__PURE__ */ new Map(), u.set(a, e));
    if (e.has(l)) return e;
    for (e.set(l, null), a = a.getElementsByTagName(l), u = 0; u < a.length; u++) {
      var n = a[u];
      if (!(n[Ge] || n[Ul] || l === "link" && n.getAttribute("rel") === "stylesheet") && n.namespaceURI !== "http://www.w3.org/2000/svg") {
        var i = n.getAttribute(t) || "";
        i = l + i;
        var c = e.get(i);
        c ? c.push(n) : e.set(i, [n]);
      }
    }
    return e;
  }
  function vm(l, t, a) {
    l = l.ownerDocument || l, l.head.insertBefore(
      a,
      t === "title" ? l.querySelector("head > title") : null
    );
  }
  function av(l, t, a) {
    if (a === 1 || t.itemProp != null) return !1;
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
  function ym(l) {
    return !(l.type === "stylesheet" && (l.state.loading & 3) === 0);
  }
  function ev(l, t, a, e) {
    if (a.type === "stylesheet" && (typeof e.media != "string" || matchMedia(e.media).matches !== !1) && (a.state.loading & 4) === 0) {
      if (a.instance === null) {
        var u = De(e.href), n = t.querySelector(
          Au(u)
        );
        if (n) {
          t = n._p, t !== null && typeof t == "object" && typeof t.then == "function" && (l.count++, l = Xn.bind(l), t.then(l, l)), a.state.loading |= 4, a.instance = n, Ml(n);
          return;
        }
        n = t.ownerDocument || t, e = mm(e), (u = zt.get(u)) && of(e, u), n = n.createElement("link"), Ml(n);
        var i = n;
        i._p = new Promise(function(c, s) {
          i.onload = c, i.onerror = s;
        }), ql(n, "link", e), a.instance = n;
      }
      l.stylesheets === null && (l.stylesheets = /* @__PURE__ */ new Map()), l.stylesheets.set(a, t), (t = a.state.preload) && (a.state.loading & 3) === 0 && (l.count++, a = Xn.bind(l), t.addEventListener("load", a), t.addEventListener("error", a));
    }
  }
  var rf = 0;
  function uv(l, t) {
    return l.stylesheets && l.count === 0 && Zn(l, l.stylesheets), 0 < l.count || 0 < l.imgCount ? function(a) {
      var e = setTimeout(function() {
        if (l.stylesheets && Zn(l, l.stylesheets), l.unsuspend) {
          var n = l.unsuspend;
          l.unsuspend = null, n();
        }
      }, 6e4 + t);
      0 < l.imgBytes && rf === 0 && (rf = 62500 * Yh());
      var u = setTimeout(
        function() {
          if (l.waitingForImages = !1, l.count === 0 && (l.stylesheets && Zn(l, l.stylesheets), l.unsuspend)) {
            var n = l.unsuspend;
            l.unsuspend = null, n();
          }
        },
        (l.imgBytes > rf ? 50 : 800) + t
      );
      return l.unsuspend = a, function() {
        l.unsuspend = null, clearTimeout(e), clearTimeout(u);
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
  var Ln = null;
  function Zn(l, t) {
    l.stylesheets = null, l.unsuspend !== null && (l.count++, Ln = /* @__PURE__ */ new Map(), t.forEach(nv, l), Ln = null, Xn.call(l));
  }
  function nv(l, t) {
    if (!(t.state.loading & 4)) {
      var a = Ln.get(l);
      if (a) var e = a.get(null);
      else {
        a = /* @__PURE__ */ new Map(), Ln.set(l, a);
        for (var u = l.querySelectorAll(
          "link[data-precedence],style[data-precedence]"
        ), n = 0; n < u.length; n++) {
          var i = u[n];
          (i.nodeName === "LINK" || i.getAttribute("media") !== "not all") && (a.set(i.dataset.precedence, i), e = i);
        }
        e && a.set(null, e);
      }
      u = t.instance, i = u.getAttribute("data-precedence"), n = a.get(i) || e, n === e && a.set(null, u), a.set(i, u), this.count++, e = Xn.bind(this), u.addEventListener("load", e), u.addEventListener("error", e), n ? n.parentNode.insertBefore(u, n.nextSibling) : (l = l.nodeType === 9 ? l.head : l, l.insertBefore(u, l.firstChild)), t.state.loading |= 4;
    }
  }
  var ju = {
    $$typeof: Bl,
    Provider: null,
    Consumer: null,
    _currentValue: Q,
    _currentValue2: Q,
    _threadCount: 0
  };
  function iv(l, t, a, e, u, n, i, c, s) {
    this.tag = 1, this.containerInfo = l, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = ci(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = ci(0), this.hiddenUpdates = ci(null), this.identifierPrefix = e, this.onUncaughtError = u, this.onCaughtError = n, this.onRecoverableError = i, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = s, this.incompleteTransitions = /* @__PURE__ */ new Map();
  }
  function gm(l, t, a, e, u, n, i, c, s, y, p, j) {
    return l = new iv(
      l,
      t,
      a,
      i,
      s,
      y,
      p,
      j,
      c
    ), t = 1, n === !0 && (t |= 24), n = et(3, null, null, t), l.current = n, n.stateNode = l, t = Ki(), t.refCount++, l.pooledCache = t, t.refCount++, n.memoizedState = {
      element: e,
      isDehydrated: a,
      cache: t
    }, Wi(n), l;
  }
  function Sm(l) {
    return l ? (l = se, l) : se;
  }
  function bm(l, t, a, e, u, n) {
    u = Sm(u), e.context === null ? e.context = u : e.pendingContext = u, e = sa(t), e.payload = { element: a }, n = n === void 0 ? null : n, n !== null && (e.callback = n), a = da(l, e, t), a !== null && (Fl(a, l, t), au(a, l, t));
  }
  function pm(l, t) {
    if (l = l.memoizedState, l !== null && l.dehydrated !== null) {
      var a = l.retryLane;
      l.retryLane = a !== 0 && a < t ? a : t;
    }
  }
  function hf(l, t) {
    pm(l, t), (l = l.alternate) && pm(l, t);
  }
  function zm(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = Ra(l, 67108864);
      t !== null && Fl(t, l, 67108864), hf(l, 67108864);
    }
  }
  function Am(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = ft();
      t = fi(t);
      var a = Ra(l, t);
      a !== null && Fl(a, l, t), hf(l, t);
    }
  }
  var Vn = !0;
  function cv(l, t, a, e) {
    var u = z.T;
    z.T = null;
    var n = D.p;
    try {
      D.p = 2, vf(l, t, a, e);
    } finally {
      D.p = n, z.T = u;
    }
  }
  function fv(l, t, a, e) {
    var u = z.T;
    z.T = null;
    var n = D.p;
    try {
      D.p = 8, vf(l, t, a, e);
    } finally {
      D.p = n, z.T = u;
    }
  }
  function vf(l, t, a, e) {
    if (Vn) {
      var u = yf(e);
      if (u === null)
        lf(
          l,
          t,
          e,
          Kn,
          a
        ), jm(l, e);
      else if (dv(
        u,
        l,
        t,
        a,
        e
      ))
        e.stopPropagation();
      else if (jm(l, e), t & 4 && -1 < sv.indexOf(l)) {
        for (; u !== null; ) {
          var n = Ia(u);
          if (n !== null)
            switch (n.tag) {
              case 3:
                if (n = n.stateNode, n.current.memoizedState.isDehydrated) {
                  var i = Oa(n.pendingLanes);
                  if (i !== 0) {
                    var c = n;
                    for (c.pendingLanes |= 2, c.entangledLanes |= 2; i; ) {
                      var s = 1 << 31 - tt(i);
                      c.entanglements[1] |= s, i &= ~s;
                    }
                    Ut(n), (nl & 6) === 0 && (_n = Pl() + 500, Su(0));
                  }
                }
                break;
              case 31:
              case 13:
                c = Ra(n, 2), c !== null && Fl(c, n, 2), Nn(), hf(n, 2);
            }
          if (n = yf(e), n === null && lf(
            l,
            t,
            e,
            Kn,
            a
          ), n === u) break;
          u = n;
        }
        u !== null && e.stopPropagation();
      } else
        lf(
          l,
          t,
          e,
          null,
          a
        );
    }
  }
  function yf(l) {
    return l = gi(l), gf(l);
  }
  var Kn = null;
  function gf(l) {
    if (Kn = null, l = Fa(l), l !== null) {
      var t = C(l);
      if (t === null) l = null;
      else {
        var a = t.tag;
        if (a === 13) {
          if (l = X(t), l !== null) return l;
          l = null;
        } else if (a === 31) {
          if (l = Z(t), l !== null) return l;
          l = null;
        } else if (a === 3) {
          if (t.stateNode.current.memoizedState.isDehydrated)
            return t.tag === 3 ? t.stateNode.containerInfo : null;
          l = null;
        } else t !== l && (l = null);
      }
    }
    return Kn = l, null;
  }
  function Tm(l) {
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
        switch ($m()) {
          case Mf:
            return 2;
          case Df:
            return 8;
          case Ru:
          case Wm:
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
  var Sf = !1, za = null, Aa = null, Ta = null, Eu = /* @__PURE__ */ new Map(), xu = /* @__PURE__ */ new Map(), ja = [], sv = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
    " "
  );
  function jm(l, t) {
    switch (l) {
      case "focusin":
      case "focusout":
        za = null;
        break;
      case "dragenter":
      case "dragleave":
        Aa = null;
        break;
      case "mouseover":
      case "mouseout":
        Ta = null;
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
  function _u(l, t, a, e, u, n) {
    return l === null || l.nativeEvent !== n ? (l = {
      blockedOn: t,
      domEventName: a,
      eventSystemFlags: e,
      nativeEvent: n,
      targetContainers: [u]
    }, t !== null && (t = Ia(t), t !== null && zm(t)), l) : (l.eventSystemFlags |= e, t = l.targetContainers, u !== null && t.indexOf(u) === -1 && t.push(u), l);
  }
  function dv(l, t, a, e, u) {
    switch (t) {
      case "focusin":
        return za = _u(
          za,
          l,
          t,
          a,
          e,
          u
        ), !0;
      case "dragenter":
        return Aa = _u(
          Aa,
          l,
          t,
          a,
          e,
          u
        ), !0;
      case "mouseover":
        return Ta = _u(
          Ta,
          l,
          t,
          a,
          e,
          u
        ), !0;
      case "pointerover":
        var n = u.pointerId;
        return Eu.set(
          n,
          _u(
            Eu.get(n) || null,
            l,
            t,
            a,
            e,
            u
          )
        ), !0;
      case "gotpointercapture":
        return n = u.pointerId, xu.set(
          n,
          _u(
            xu.get(n) || null,
            l,
            t,
            a,
            e,
            u
          )
        ), !0;
    }
    return !1;
  }
  function Em(l) {
    var t = Fa(l.target);
    if (t !== null) {
      var a = C(t);
      if (a !== null) {
        if (t = a.tag, t === 13) {
          if (t = X(a), t !== null) {
            l.blockedOn = t, Yf(l.priority, function() {
              Am(a);
            });
            return;
          }
        } else if (t === 31) {
          if (t = Z(a), t !== null) {
            l.blockedOn = t, Yf(l.priority, function() {
              Am(a);
            });
            return;
          }
        } else if (t === 3 && a.stateNode.current.memoizedState.isDehydrated) {
          l.blockedOn = a.tag === 3 ? a.stateNode.containerInfo : null;
          return;
        }
      }
    }
    l.blockedOn = null;
  }
  function Jn(l) {
    if (l.blockedOn !== null) return !1;
    for (var t = l.targetContainers; 0 < t.length; ) {
      var a = yf(l.nativeEvent);
      if (a === null) {
        a = l.nativeEvent;
        var e = new a.constructor(
          a.type,
          a
        );
        yi = e, a.target.dispatchEvent(e), yi = null;
      } else
        return t = Ia(a), t !== null && zm(t), l.blockedOn = a, !1;
      t.shift();
    }
    return !0;
  }
  function xm(l, t, a) {
    Jn(l) && a.delete(t);
  }
  function ov() {
    Sf = !1, za !== null && Jn(za) && (za = null), Aa !== null && Jn(Aa) && (Aa = null), Ta !== null && Jn(Ta) && (Ta = null), Eu.forEach(xm), xu.forEach(xm);
  }
  function wn(l, t) {
    l.blockedOn === t && (l.blockedOn = null, Sf || (Sf = !0, r.unstable_scheduleCallback(
      r.unstable_NormalPriority,
      ov
    )));
  }
  var $n = null;
  function _m(l) {
    $n !== l && ($n = l, r.unstable_scheduleCallback(
      r.unstable_NormalPriority,
      function() {
        $n === l && ($n = null);
        for (var t = 0; t < l.length; t += 3) {
          var a = l[t], e = l[t + 1], u = l[t + 2];
          if (typeof e != "function") {
            if (gf(e || a) === null)
              continue;
            break;
          }
          var n = Ia(a);
          n !== null && (l.splice(t, 3), t -= 3, vc(
            n,
            {
              pending: !0,
              data: u,
              method: a.method,
              action: e
            },
            e,
            u
          ));
        }
      }
    ));
  }
  function Re(l) {
    function t(s) {
      return wn(s, l);
    }
    za !== null && wn(za, l), Aa !== null && wn(Aa, l), Ta !== null && wn(Ta, l), Eu.forEach(t), xu.forEach(t);
    for (var a = 0; a < ja.length; a++) {
      var e = ja[a];
      e.blockedOn === l && (e.blockedOn = null);
    }
    for (; 0 < ja.length && (a = ja[0], a.blockedOn === null); )
      Em(a), a.blockedOn === null && ja.shift();
    if (a = (l.ownerDocument || l).$$reactFormReplay, a != null)
      for (e = 0; e < a.length; e += 3) {
        var u = a[e], n = a[e + 1], i = u[Kl] || null;
        if (typeof n == "function")
          i || _m(a);
        else if (i) {
          var c = null;
          if (n && n.hasAttribute("formAction")) {
            if (u = n, i = n[Kl] || null)
              c = i.formAction;
            else if (gf(u) !== null) continue;
          } else c = i.action;
          typeof c == "function" ? a[e + 1] = c : (a.splice(e, 3), e -= 3), _m(a);
        }
      }
  }
  function Om() {
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
      u !== null && (u(), u = null), e || setTimeout(a, 20);
    }
    function a() {
      if (!e && !navigation.transition) {
        var n = navigation.currentEntry;
        n && n.url != null && navigation.navigate(n.url, {
          state: n.getState(),
          info: "react-transition",
          history: "replace"
        });
      }
    }
    if (typeof navigation == "object") {
      var e = !1, u = null;
      return navigation.addEventListener("navigate", l), navigation.addEventListener("navigatesuccess", t), navigation.addEventListener("navigateerror", t), setTimeout(a, 100), function() {
        e = !0, navigation.removeEventListener("navigate", l), navigation.removeEventListener("navigatesuccess", t), navigation.removeEventListener("navigateerror", t), u !== null && (u(), u = null);
      };
    }
  }
  function bf(l) {
    this._internalRoot = l;
  }
  Wn.prototype.render = bf.prototype.render = function(l) {
    var t = this._internalRoot;
    if (t === null) throw Error(o(409));
    var a = t.current, e = ft();
    bm(a, e, l, t, null, null);
  }, Wn.prototype.unmount = bf.prototype.unmount = function() {
    var l = this._internalRoot;
    if (l !== null) {
      this._internalRoot = null;
      var t = l.containerInfo;
      bm(l.current, 2, null, l, null, null), Nn(), t[ka] = null;
    }
  };
  function Wn(l) {
    this._internalRoot = l;
  }
  Wn.prototype.unstable_scheduleHydration = function(l) {
    if (l) {
      var t = Bf();
      l = { blockedOn: null, target: l, priority: t };
      for (var a = 0; a < ja.length && t !== 0 && t < ja[a].priority; a++) ;
      ja.splice(a, 0, l), a === 0 && Em(l);
    }
  };
  var Nm = x.version;
  if (Nm !== "19.2.8")
    throw Error(
      o(
        527,
        Nm,
        "19.2.8"
      )
    );
  D.findDOMNode = function(l) {
    var t = l._reactInternals;
    if (t === void 0)
      throw typeof l.render == "function" ? Error(o(188)) : (l = Object.keys(l).join(","), Error(o(268, l)));
    return l = b(t), l = l !== null ? N(l) : null, l = l === null ? null : l.stateNode, l;
  };
  var mv = {
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
        qe = kn.inject(
          mv
        ), lt = kn;
      } catch {
      }
  }
  return Nu.createRoot = function(l, t) {
    if (!H(l)) throw Error(o(299));
    var a = !1, e = "", u = Hd, n = qd, i = Bd;
    return t != null && (t.unstable_strictMode === !0 && (a = !0), t.identifierPrefix !== void 0 && (e = t.identifierPrefix), t.onUncaughtError !== void 0 && (u = t.onUncaughtError), t.onCaughtError !== void 0 && (n = t.onCaughtError), t.onRecoverableError !== void 0 && (i = t.onRecoverableError)), t = gm(
      l,
      1,
      !1,
      null,
      null,
      a,
      e,
      null,
      u,
      n,
      i,
      Om
    ), l[ka] = t.current, Pc(l), new bf(t);
  }, Nu.hydrateRoot = function(l, t, a) {
    if (!H(l)) throw Error(o(299));
    var e = !1, u = "", n = Hd, i = qd, c = Bd, s = null;
    return a != null && (a.unstable_strictMode === !0 && (e = !0), a.identifierPrefix !== void 0 && (u = a.identifierPrefix), a.onUncaughtError !== void 0 && (n = a.onUncaughtError), a.onCaughtError !== void 0 && (i = a.onCaughtError), a.onRecoverableError !== void 0 && (c = a.onRecoverableError), a.formState !== void 0 && (s = a.formState)), t = gm(
      l,
      1,
      !0,
      t,
      a ?? null,
      e,
      u,
      s,
      n,
      i,
      c,
      Om
    ), t.context = Sm(null), a = t.current, e = ft(), e = fi(e), u = sa(e), u.callback = null, da(a, u, e), a = e, t.current.lanes = a, Ye(t, a), Ut(t), l[ka] = t.current, Pc(l), new Wn(t);
  }, Nu.version = "19.2.8", Nu;
}
var Gm;
function Av() {
  if (Gm) return Af.exports;
  Gm = 1;
  function r() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(r);
      } catch (x) {
        console.error(x);
      }
  }
  return r(), Af.exports = zv(), Af.exports;
}
var Tv = Av();
class jv extends Error {
  constructor(x, M, o) {
    super(x), this.status = M, this.payload = o;
  }
  status;
  payload;
}
async function st(r, x = {}) {
  const M = new Headers(x.headers);
  x.body && !M.has("content-type") && M.set("content-type", "application/json");
  const o = await fetch(r, { ...x, headers: M, credentials: "same-origin" });
  let H = {};
  try {
    H = await o.json();
  } catch {
  }
  if (!o.ok) {
    const C = H && typeof H == "object" ? H : {}, X = typeof C.error == "string" ? C.error : typeof C.message == "string" ? C.message : `Request failed (${o.status})`;
    throw new jv(X, o.status, H);
  }
  return H;
}
const dt = {
  commandCenter: () => st("/api/console/command-center"),
  work: () => st("/api/console/requirements"),
  automations: () => st("/api/console/automations"),
  automationSettings: () => st("/api/console/automation-settings"),
  connector: () => st("/api/console/connector/status"),
  advanced: () => st("/api/console/advanced"),
  automationAction: (r, x, M, o) => st(`/api/console/automations/${encodeURIComponent(r)}/${encodeURIComponent(x)}/${encodeURIComponent(M)}/${encodeURIComponent(o)}`, { method: "POST", body: "{}" }),
  providerAction: (r, x) => st(`/api/console/providers/${encodeURIComponent(r)}/${x}`, { method: "POST", body: "{}" }),
  providerHealth: (r) => st("/api/console/providers/health", { method: "POST", body: JSON.stringify({ providerId: r }) }),
  localToolAction: (r, x) => st(`/api/console/local-tools/${encodeURIComponent(r)}/${x}`, { method: "POST", body: "{}" }),
  localToolHealth: (r) => st("/api/console/local-tools/health", { method: "POST", body: JSON.stringify({ toolId: r }) }),
  registerRepository: (r, x) => st("/api/repositories/register", { method: "POST", body: JSON.stringify({ path: r, displayName: x }) }),
  removeRepository: (r) => st(`/api/repositories/${encodeURIComponent(r)}/remove`, { method: "POST", body: "{}" })
}, Zm = [
  { id: "overview", label: "Overview", group: "daily" },
  { id: "automations", label: "Automations", group: "daily" },
  { id: "work", label: "Work", group: "daily" },
  { id: "capabilities", label: "Capabilities", group: "manage" },
  { id: "repositories", label: "Repositories", group: "manage" },
  { id: "settings", label: "Settings", group: "manage" },
  { id: "system", label: "System", group: "system" }
];
function Qm() {
  const r = location.hash.replace(/^#\/?/, "").split("/")[0];
  return Zm.some((x) => x.id === r) ? r : "overview";
}
function Pt({ children: r, ...x }) {
  return /* @__PURE__ */ f.jsx("svg", { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: "1.55", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", ...x, children: r });
}
const Ev = (r) => /* @__PURE__ */ f.jsx(Pt, { ...r, children: /* @__PURE__ */ f.jsx("path", { d: "M3 9.2 10 3l7 6.2v7.1a.7.7 0 0 1-.7.7h-4.2v-5H7.9v5H3.7a.7.7 0 0 1-.7-.7z" }) }), xv = (r) => /* @__PURE__ */ f.jsxs(Pt, { ...r, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4.2 6.3A6.5 6.5 0 0 1 16 7" }),
  /* @__PURE__ */ f.jsx("path", { d: "m16 3 .4 4.4-4.4.4" }),
  /* @__PURE__ */ f.jsx("path", { d: "M15.8 13.7A6.5 6.5 0 0 1 4 13" }),
  /* @__PURE__ */ f.jsx("path", { d: "m4 17-.4-4.4 4.4-.4" })
] }), _v = (r) => /* @__PURE__ */ f.jsxs(Pt, { ...r, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4 5.2h12v10.6H4z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M7 5.2V3.6h6v1.6M7 9h6M7 12h4" })
] }), Ov = (r) => /* @__PURE__ */ f.jsx(Pt, { ...r, children: /* @__PURE__ */ f.jsx("path", { d: "m10 2.8 2 4 4.4.7-3.2 3.1.8 4.4-4-2.1L6 15l.8-4.4-3.2-3.1L8 6.8z" }) }), Nv = (r) => /* @__PURE__ */ f.jsxs(Pt, { ...r, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M4 3.5h5l1.4 2H16v11H4z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M4 8h12" })
] }), Mv = (r) => /* @__PURE__ */ f.jsxs(Pt, { ...r, children: [
  /* @__PURE__ */ f.jsx("circle", { cx: "10", cy: "10", r: "2.5" }),
  /* @__PURE__ */ f.jsx("path", { d: "M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" })
] }), Dv = (r) => /* @__PURE__ */ f.jsxs(Pt, { ...r, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M3.2 4.5h13.6v9.2H3.2z" }),
  /* @__PURE__ */ f.jsx("path", { d: "M7 17h6M10 13.7V17" })
] }), Uv = (r) => /* @__PURE__ */ f.jsxs(Pt, { ...r, children: [
  /* @__PURE__ */ f.jsx("path", { d: "M15.5 6A6 6 0 1 0 16 12" }),
  /* @__PURE__ */ f.jsx("path", { d: "m15.5 2.8.3 3.7-3.7.2" })
] }), Rv = (r) => /* @__PURE__ */ f.jsxs(Pt, { ...r, children: [
  /* @__PURE__ */ f.jsx("circle", { cx: "8.8", cy: "8.8", r: "5" }),
  /* @__PURE__ */ f.jsx("path", { d: "m12.5 12.5 4 4" })
] }), Cv = { overview: Ev, automations: xv, work: _v, capabilities: Ov, repositories: Nv, settings: Mv, system: Dv };
function Hv({ route: r }) {
  let x = "";
  return /* @__PURE__ */ f.jsxs("aside", { className: "sidebar", children: [
    /* @__PURE__ */ f.jsxs("div", { className: "brand", children: [
      /* @__PURE__ */ f.jsx("span", { className: "brand-mark", children: "F" }),
      /* @__PURE__ */ f.jsxs("div", { children: [
        /* @__PURE__ */ f.jsx("strong", { children: "Forge" }),
        /* @__PURE__ */ f.jsx("small", { children: "Utility Console" })
      ] })
    ] }),
    /* @__PURE__ */ f.jsx("nav", { children: Zm.map((M) => {
      const o = Cv[M.id], H = !!(x && x !== M.group);
      return x = M.group, /* @__PURE__ */ f.jsx("div", { className: H ? "nav-group-start" : "", children: /* @__PURE__ */ f.jsxs("a", { href: `#/${M.id}`, className: r === M.id ? "active" : "", children: [
        /* @__PURE__ */ f.jsx(o, {}),
        /* @__PURE__ */ f.jsx("span", { children: M.label })
      ] }) }, M.id);
    }) }),
    /* @__PURE__ */ f.jsxs("div", { className: "sidebar-foot", children: [
      /* @__PURE__ */ f.jsx("span", { className: "pulse-dot" }),
      "ChatGPT is the primary workspace"
    ] })
  ] });
}
function qv({ route: r, children: x }) {
  return /* @__PURE__ */ f.jsxs("div", { className: "app-shell", children: [
    /* @__PURE__ */ f.jsx(Hv, { route: r }),
    /* @__PURE__ */ f.jsx("main", { className: "workspace", children: x })
  ] });
}
function Ja(r) {
  if (!r) return "—";
  const x = new Date(r);
  return Number.isNaN(x.getTime()) ? r : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: !1 }).format(x);
}
function It(r, x = 86) {
  const M = (r ?? "").trim();
  return M.length > x ? `${M.slice(0, x - 1)}…` : M;
}
function Ce(r, x = "—") {
  return typeof r == "string" && r.trim() ? r : String(r ?? x);
}
function Pn(r) {
  return JSON.stringify(r ?? {}, null, 2);
}
function $a({ eyebrow: r, title: x, description: M, refreshedAt: o, busy: H, onRefresh: C, actions: X }) {
  return /* @__PURE__ */ f.jsxs("header", { className: "command-bar", children: [
    /* @__PURE__ */ f.jsxs("div", { className: "command-title", children: [
      r && /* @__PURE__ */ f.jsx("div", { className: "eyebrow", children: r }),
      /* @__PURE__ */ f.jsx("h1", { children: x }),
      /* @__PURE__ */ f.jsx("p", { children: M })
    ] }),
    /* @__PURE__ */ f.jsxs("div", { className: "command-actions", children: [
      /* @__PURE__ */ f.jsxs("span", { className: "refreshed", children: [
        "Updated ",
        Ja(o)
      ] }),
      /* @__PURE__ */ f.jsx("button", { className: "icon-button", onClick: C, disabled: H, title: "Refresh", children: /* @__PURE__ */ f.jsx(Uv, {}) }),
      X,
      /* @__PURE__ */ f.jsx("a", { className: "button ghost-link", href: "https://chatgpt.com", target: "_blank", rel: "noreferrer", children: "ChatGPT ↗" })
    ] })
  ] });
}
function Bv(r) {
  const x = (r ?? "").toLowerCase();
  return /ready|enabled|healthy|success|done|completed|active/.test(x) ? "success" : /attention|blocked|error|fail|danger/.test(x) ? "danger" : /pause|waiting|warn|degrad|stale|planned/.test(x) ? "warning" : /info|running/.test(x) ? "info" : "neutral";
}
function Xl({ label: r, tone: x }) {
  const M = x && ["success", "warning", "danger", "info", "neutral"].includes(x) ? x : Bv(x ?? r);
  return /* @__PURE__ */ f.jsxs("span", { className: "status-text", children: [
    /* @__PURE__ */ f.jsx("i", { className: `status-dot ${M}` }),
    r
  ] });
}
function In({ title: r, meta: x, actions: M }) {
  return /* @__PURE__ */ f.jsxs("div", { className: "section-header", children: [
    /* @__PURE__ */ f.jsxs("div", { children: [
      /* @__PURE__ */ f.jsx("h2", { children: r }),
      x && /* @__PURE__ */ f.jsx("span", { children: x })
    ] }),
    M && /* @__PURE__ */ f.jsx("div", { children: M })
  ] });
}
function Xm(r) {
  return `${String(r.title ?? "")}:${String(r.reason ?? "")}`;
}
function Yv({ data: r, busy: x, onRefresh: M }) {
  const o = r.commandCenter, H = r.automations.summary, C = r.work, X = o.pluginSummary ?? {}, Z = o.repositories ?? [], O = o.readiness ?? {}, b = [...o.handoffs ?? []].filter((_, ll, jl) => jl.findIndex((ul) => Xm(ul) === Xm(_)) === ll), N = C.waitingForUserCount ?? 0, A = [...b.slice(0, 3), ...N ? [{ title: "Persistent work needs attention", reason: `${N} 项长期目标需要确认`, statusLabel: "Review", tone: "warning" }] : [], ...X.needsAttention ?? 0 ? [{ title: "Capabilities need attention", reason: `${X.needsAttention} 项能力需要配置或检查`, statusLabel: "Inspect", tone: "warning" }] : []].slice(0, 4);
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($a, { eyebrow: "FORGE", title: "Overview", description: "长期配置与系统可用性。执行结果和通知继续由 ChatGPT 承担。", refreshedAt: r.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ f.jsxs("div", { className: "metric-strip", children: [
      /* @__PURE__ */ f.jsxs("a", { href: "#/automations", children: [
        /* @__PURE__ */ f.jsx("span", { children: "Automations" }),
        /* @__PURE__ */ f.jsx("strong", { children: H.enabled }),
        /* @__PURE__ */ f.jsx("small", { children: H.paused ? `${H.paused} paused` : "enabled" })
      ] }),
      /* @__PURE__ */ f.jsxs("a", { href: "#/capabilities", children: [
        /* @__PURE__ */ f.jsx("span", { children: "Capabilities" }),
        /* @__PURE__ */ f.jsxs("strong", { children: [
          X.ready ?? 0,
          "/",
          X.total ?? (o.plugins ?? []).length
        ] }),
        /* @__PURE__ */ f.jsx("small", { children: "ready" })
      ] }),
      /* @__PURE__ */ f.jsxs("a", { href: "#/repositories", children: [
        /* @__PURE__ */ f.jsx("span", { children: "Repositories" }),
        /* @__PURE__ */ f.jsx("strong", { children: Z.length }),
        /* @__PURE__ */ f.jsx("small", { children: "registered" })
      ] }),
      /* @__PURE__ */ f.jsxs("a", { href: "#/work", children: [
        /* @__PURE__ */ f.jsx("span", { children: "Persistent work" }),
        /* @__PURE__ */ f.jsx("strong", { children: C.activeRequirementCount ?? 0 }),
        /* @__PURE__ */ f.jsxs("small", { children: [
          C.waitingForUserCount ?? 0,
          " waiting"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ f.jsxs("section", { className: "page-section", children: [
      /* @__PURE__ */ f.jsx(In, { title: "Needs attention", meta: A.length ? `${A.length} actionable groups` : "All clear" }),
      A.length ? /* @__PURE__ */ f.jsx("div", { className: "attention-list", children: A.map((_, ll) => /* @__PURE__ */ f.jsxs("div", { className: "attention-row", children: [
        /* @__PURE__ */ f.jsx("span", { className: "attention-index", children: String(ll + 1).padStart(2, "0") }),
        /* @__PURE__ */ f.jsxs("div", { children: [
          /* @__PURE__ */ f.jsx("strong", { children: String(_.title ?? "需要处理") }),
          /* @__PURE__ */ f.jsx("p", { children: It(String(_.reason ?? "请在 ChatGPT 中确认"), 120) })
        ] }),
        /* @__PURE__ */ f.jsx(Xl, { label: String(_.statusLabel ?? "Review"), tone: String(_.tone ?? "warning") })
      ] }, `${String(_.title)}-${ll}`)) }) : /* @__PURE__ */ f.jsxs("div", { className: "quiet-empty", children: [
        /* @__PURE__ */ f.jsx(Xl, { label: String(O.label ?? O.headline ?? "Ready"), tone: String(O.state ?? "success") }),
        /* @__PURE__ */ f.jsx("p", { children: "当前没有需要你在控制台处理的配置问题。" })
      ] })
    ] }),
    /* @__PURE__ */ f.jsxs("section", { className: "page-section", children: [
      /* @__PURE__ */ f.jsx(In, { title: "Configured work", meta: "只显示持久化目标，不展示执行流水" }),
      /* @__PURE__ */ f.jsx("div", { className: "compact-work-list", children: (C.requirements ?? []).filter((_) => _.state !== "done" && _.state !== "cancelled").slice(0, 5).map((_) => /* @__PURE__ */ f.jsxs("a", { href: "#/work", children: [
        /* @__PURE__ */ f.jsxs("div", { children: [
          /* @__PURE__ */ f.jsx("strong", { children: _.title }),
          /* @__PURE__ */ f.jsx("p", { children: It(_.outcome, 100) })
        ] }),
        /* @__PURE__ */ f.jsx(Xl, { label: _.state === "waiting_for_user" ? "Waiting" : _.state === "planned" ? "Planned" : "Active", tone: _.state })
      ] }, _.requirementId)) })
    ] })
  ] });
}
function _f({ items: r, value: x, onChange: M }) {
  return /* @__PURE__ */ f.jsx("div", { className: "segmented", role: "tablist", children: r.map((o) => /* @__PURE__ */ f.jsxs("button", { role: "tab", "aria-selected": x === o.id, className: x === o.id ? "selected" : "", onClick: () => M(o.id), children: [
    o.label,
    o.count !== void 0 && /* @__PURE__ */ f.jsx("span", { children: o.count })
  ] }, o.id)) });
}
function li({ title: r, subtitle: x, actions: M, children: o, empty: H }) {
  return /* @__PURE__ */ f.jsx("aside", { className: "detail-pane", children: r ? /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsxs("div", { className: "detail-head", children: [
      /* @__PURE__ */ f.jsxs("div", { children: [
        /* @__PURE__ */ f.jsx("div", { className: "eyebrow", children: "DETAIL" }),
        /* @__PURE__ */ f.jsx("h2", { children: r }),
        x && /* @__PURE__ */ f.jsx("p", { children: x })
      ] }),
      M && /* @__PURE__ */ f.jsx("div", { className: "detail-actions", children: M })
    ] }),
    /* @__PURE__ */ f.jsx("div", { className: "detail-body", children: o })
  ] }) : /* @__PURE__ */ f.jsx("div", { className: "detail-empty", children: H ?? "选择一项查看详细配置" }) });
}
function Du({ items: r }) {
  return /* @__PURE__ */ f.jsx("dl", { className: "definition-list", children: r.map(([x, M]) => /* @__PURE__ */ f.jsxs("div", { children: [
    /* @__PURE__ */ f.jsx("dt", { children: x }),
    /* @__PURE__ */ f.jsx("dd", { children: M })
  ] }, x)) });
}
function wa({ children: r, className: x = "", ...M }) {
  return /* @__PURE__ */ f.jsx("button", { className: `button ${x}`.trim(), ...M, children: r });
}
function Gv({ data: r, busy: x, onRefresh: M, onAction: o }) {
  const H = r.automations.automations, [C, X] = Sl.useState("enabled"), Z = Sl.useMemo(() => H.filter((_) => C === "all" || _.status === C), [H, C]), [O, b] = Sl.useState(), N = (_) => `${_.source}:${_.repoId}:${_.id}`, A = Z.find((_) => N(_) === O) ?? Z[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($a, { eyebrow: "LONG-RUNNING CONFIG", title: "Automations", description: "管理 Forge 持久化 Schedule 与 Assistant Routine；结果正文继续发送到 ChatGPT / Email。", refreshedAt: r.automations.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ f.jsx("div", { className: "toolbar", children: /* @__PURE__ */ f.jsx(_f, { value: C, onChange: X, items: [{ id: "enabled", label: "Enabled", count: H.filter((_) => _.status === "enabled").length }, { id: "paused", label: "Paused", count: H.filter((_) => _.status === "paused").length }, { id: "attention", label: "Attention", count: H.filter((_) => _.status === "attention").length }, { id: "all", label: "All", count: H.length }] }) }),
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
          /* @__PURE__ */ f.jsx("tbody", { children: Z.map((_) => /* @__PURE__ */ f.jsxs("tr", { className: A && N(A) === N(_) ? "selected" : "", onClick: () => b(N(_)), children: [
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx("strong", { children: _.name }),
              /* @__PURE__ */ f.jsxs("small", { children: [
                _.repositoryName,
                " · ",
                _.source
              ] })
            ] }),
            /* @__PURE__ */ f.jsx("td", { children: _.schedule }),
            /* @__PURE__ */ f.jsx("td", { children: _.delivery ?? "—" }),
            /* @__PURE__ */ f.jsx("td", { children: /* @__PURE__ */ f.jsx(Xl, { label: _.status, tone: _.status }) }),
            /* @__PURE__ */ f.jsxs("td", { children: [
              /* @__PURE__ */ f.jsx("span", { children: It(_.lastResult, 30) || "—" }),
              /* @__PURE__ */ f.jsx("small", { children: Ja(_.lastRunAt) })
            ] }),
            /* @__PURE__ */ f.jsx("td", { children: Ja(_.nextRunHint) })
          ] }, N(_))) })
        ] }),
        !Z.length && /* @__PURE__ */ f.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Automation。" })
      ] }),
      /* @__PURE__ */ f.jsx(li, { title: A?.name, subtitle: A?.summary, empty: "选择一个 Automation 查看配置", children: A && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Du, { items: [["Status", /* @__PURE__ */ f.jsx(Xl, { label: A.status, tone: A.status })], ["Schedule", A.schedule], ["Source", A.source], ["Repository", A.repositoryName], ["Delivery", A.delivery ?? "—"], ["Last result", A.lastResult ?? "—"], ["Last run", Ja(A.lastRunAt)], ["Next", Ja(A.nextRunHint)]] }),
        A.pausedReason && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Paused reason" }),
          /* @__PURE__ */ f.jsx("p", { children: A.pausedReason })
        ] }),
        /* @__PURE__ */ f.jsx("div", { className: "detail-button-row", children: A.actions.map((_) => /* @__PURE__ */ f.jsx(wa, { disabled: x, className: _ === "pause" ? "danger-text" : "", onClick: () => {
          o(A, _);
        }, children: _ === "run" ? "Run now" : _ === "pause" ? "Pause" : "Resume" }, _)) }),
        /* @__PURE__ */ f.jsx("p", { className: "detail-note", children: "这里只保存调度配置与最近一次结果摘要，不复制日报、SEO 或研究正文。" })
      ] }) })
    ] })
  ] });
}
function Fn(r, x) {
  return x === "all" ? !0 : x === "waiting" ? r.state === "waiting_for_user" : x === "completed" ? r.state === "done" || r.state === "cancelled" : r.state === "active" || r.state === "planned";
}
function Qv({ data: r, busy: x, onRefresh: M }) {
  const o = r.work.requirements ?? [], [H, C] = Sl.useState("active"), X = Sl.useMemo(() => o.filter((N) => Fn(N, H)), [o, H]), [Z, O] = Sl.useState(), b = X.find((N) => N.requirementId === Z) ?? X[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($a, { eyebrow: "PERSISTENT GOALS", title: "Work", description: "粗粒度查看长期目标；不展示 Agent 步骤、Run 流水或推测进度。", refreshedAt: r.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ f.jsx("div", { className: "toolbar", children: /* @__PURE__ */ f.jsx(_f, { value: H, onChange: C, items: [{ id: "active", label: "Open", count: o.filter((N) => Fn(N, "active")).length }, { id: "waiting", label: "Waiting", count: o.filter((N) => Fn(N, "waiting")).length }, { id: "completed", label: "Completed", count: o.filter((N) => Fn(N, "completed")).length }, { id: "all", label: "All", count: o.length }] }) }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "scan-list", children: [
        X.map((N) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row ${b?.requirementId === N.requirementId ? "selected" : ""}`, onClick: () => O(N.requirementId), children: [
          /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
            /* @__PURE__ */ f.jsx("strong", { children: N.title }),
            /* @__PURE__ */ f.jsx("p", { children: It(N.outcome || N.blocker, 96) })
          ] }),
          /* @__PURE__ */ f.jsxs("div", { className: "scan-meta", children: [
            /* @__PURE__ */ f.jsx(Xl, { label: N.state === "waiting_for_user" ? "Waiting" : N.state === "done" ? "Completed" : N.state === "planned" ? "Planned" : "Active", tone: N.state }),
            /* @__PURE__ */ f.jsx("time", { children: Ja(N.updatedAt) })
          ] })
        ] }, N.requirementId)),
        !X.length && /* @__PURE__ */ f.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有持久化目标。" })
      ] }),
      /* @__PURE__ */ f.jsx(li, { title: b?.title, subtitle: b?.outcome, empty: "选择一个长期目标查看完整上下文", children: b && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Du, { items: [["State", /* @__PURE__ */ f.jsx(Xl, { label: b.state, tone: b.state })], ["Updated", Ja(b.updatedAt)], ["Requirement", /* @__PURE__ */ f.jsx("code", { children: b.requirementId })]] }),
        b.blocker && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Blocker" }),
          /* @__PURE__ */ f.jsx("p", { children: b.blocker })
        ] }),
        b.requiredUserDecision && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout danger", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Decision required" }),
          /* @__PURE__ */ f.jsx("p", { children: b.requiredUserDecision })
        ] }),
        /* @__PURE__ */ f.jsx("p", { className: "detail-note", children: "执行步骤、检查证据和 Run 细节不在这里展开；继续工作请回到 ChatGPT。" })
      ] }) })
    ] })
  ] });
}
function Mu(r) {
  const x = `${r.name} ${r.provider} ${(r.capabilityLabels ?? []).join(" ")}`.toLowerCase();
  return /gmail|calendar|github|google task|notion/.test(x) ? "services" : /browser|desktop|ios|repository|codegraph|local/.test(x) ? "execution" : "extensions";
}
function Xv({ data: r, busy: x, onRefresh: M }) {
  const o = r.commandCenter.plugins ?? [], H = r.automationSettings.providers ?? [], [C, X] = Sl.useState("all"), [Z, O] = Sl.useState(), b = Sl.useMemo(() => o.filter((A) => C === "all" || C === "models" || Mu(A) === C), [o, C]), N = b.find((A) => A.id === Z) ?? b[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($a, { eyebrow: "CAPABILITY CATALOG", title: "Capabilities", description: "从“Forge 能做什么”查看扩展、服务、执行能力和模型，而不是浏览 MCP tool 清单。", refreshedAt: r.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ f.jsx("div", { className: "toolbar", children: /* @__PURE__ */ f.jsx(_f, { value: C, onChange: X, items: [{ id: "all", label: "All", count: o.length + H.length }, { id: "extensions", label: "Extensions", count: o.filter((A) => Mu(A) === "extensions").length }, { id: "services", label: "Services", count: o.filter((A) => Mu(A) === "services").length }, { id: "execution", label: "Execution", count: o.filter((A) => Mu(A) === "execution").length }, { id: "models", label: "Models", count: H.length }] }) }),
    C === "models" ? /* @__PURE__ */ f.jsx("div", { className: "single-list", children: /* @__PURE__ */ f.jsx("div", { className: "scan-list", children: H.map((A) => /* @__PURE__ */ f.jsxs("div", { className: "scan-row static", children: [
      /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
        /* @__PURE__ */ f.jsx("strong", { children: A.displayName }),
        /* @__PURE__ */ f.jsx("p", { children: It(A.explanation ?? A.summary, 110) })
      ] }),
      /* @__PURE__ */ f.jsx(Xl, { label: A.statusLabel ?? A.status ?? "Unknown", tone: A.status })
    ] }, A.providerId)) }) }) : /* @__PURE__ */ f.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ f.jsx("div", { className: "scan-list", children: b.map((A) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row ${N?.id === A.id ? "selected" : ""}`, onClick: () => O(A.id), children: [
        /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ f.jsx("span", { className: "row-eyebrow", children: Mu(A).toUpperCase() }),
          /* @__PURE__ */ f.jsx("strong", { children: A.name }),
          /* @__PURE__ */ f.jsx("p", { children: It(A.description, 100) })
        ] }),
        /* @__PURE__ */ f.jsx(Xl, { label: A.statusLabel ?? A.status ?? "Unknown", tone: A.status ?? A.tone })
      ] }, A.id)) }),
      /* @__PURE__ */ f.jsx(li, { title: N?.name, subtitle: N?.description, children: N && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Du, { items: [["Status", /* @__PURE__ */ f.jsx(Xl, { label: N.statusLabel ?? N.status ?? "Unknown", tone: N.status ?? N.tone })], ["Provider", N.provider ?? "—"], ["Health", N.healthLabel ?? "—"], ["Lifecycle", N.lifecycleLabel ?? "—"]] }),
        N.nextStep && /* @__PURE__ */ f.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ f.jsx("strong", { children: "Next step" }),
          /* @__PURE__ */ f.jsx("p", { children: N.nextStep })
        ] }),
        (N.capabilityLabels ?? []).length > 0 && /* @__PURE__ */ f.jsx("div", { className: "capability-lines", children: N.capabilityLabels.map((A) => /* @__PURE__ */ f.jsx("span", { children: A }, A)) }),
        (N.warnings ?? []).map((A) => /* @__PURE__ */ f.jsx("div", { className: "detail-callout warning", children: A }, A)),
        /* @__PURE__ */ f.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced · actions & protocol" }),
          /* @__PURE__ */ f.jsx("pre", { children: Pn({ actions: N.actions, advanced: N.advanced }) })
        ] })
      ] }) })
    ] })
  ] });
}
function Lv({ value: r, onChange: x, placeholder: M = "Search…" }) {
  return /* @__PURE__ */ f.jsxs("label", { className: "search-field", children: [
    /* @__PURE__ */ f.jsx(Rv, {}),
    /* @__PURE__ */ f.jsx("input", { value: r, onChange: (o) => x(o.target.value), placeholder: M })
  ] });
}
function Zv({ data: r, busy: x, onRefresh: M, onRegister: o, onRemove: H }) {
  const C = r.commandCenter.repositories ?? [], [X, Z] = Sl.useState(""), [O, b] = Sl.useState(), [N, A] = Sl.useState(""), [_, ll] = Sl.useState(""), jl = Sl.useMemo(() => C.filter((tl) => `${tl.name} ${tl.path} ${tl.branchLabel}`.toLowerCase().includes(X.toLowerCase())), [C, X]), ul = jl.find((tl) => tl.id === O) ?? jl[0];
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($a, { eyebrow: "CONTROLLER REGISTRY", title: "Repositories", description: "管理 Forge 已注册仓库；不存在隐含的全局“当前仓库”。", refreshedAt: r.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ f.jsxs("div", { className: "repository-tools", children: [
      /* @__PURE__ */ f.jsx(Lv, { value: X, onChange: Z, placeholder: "Search repositories…" }),
      /* @__PURE__ */ f.jsxs("form", { onSubmit: (tl) => {
        tl.preventDefault(), N.trim() && o(N.trim(), _.trim() || void 0).then(() => {
          A(""), ll("");
        });
      }, children: [
        /* @__PURE__ */ f.jsx("input", { value: N, onChange: (tl) => A(tl.target.value), placeholder: "/absolute/path" }),
        /* @__PURE__ */ f.jsx("input", { value: _, onChange: (tl) => ll(tl.target.value), placeholder: "Display name (optional)" }),
        /* @__PURE__ */ f.jsx(wa, { disabled: x || !N.trim(), children: "Add" })
      ] })
    ] }),
    /* @__PURE__ */ f.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ f.jsx("div", { className: "scan-list", children: jl.map((tl) => /* @__PURE__ */ f.jsxs("button", { className: `scan-row ${ul?.id === tl.id ? "selected" : ""}`, onClick: () => b(tl.id), children: [
        /* @__PURE__ */ f.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ f.jsx("strong", { children: tl.name }),
          /* @__PURE__ */ f.jsx("p", { children: It(tl.path, 100) })
        ] }),
        /* @__PURE__ */ f.jsxs("div", { className: "scan-meta", children: [
          /* @__PURE__ */ f.jsx(Xl, { label: tl.readinessLabel ?? tl.statusLabel ?? "Registered", tone: tl.readinessLabel ?? tl.statusLabel }),
          /* @__PURE__ */ f.jsx("span", { children: tl.branchLabel ?? "—" })
        ] })
      ] }, tl.id)) }),
      /* @__PURE__ */ f.jsx(li, { title: ul?.name, subtitle: ul?.path, children: ul && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
        /* @__PURE__ */ f.jsx(Du, { items: [["Repository id", /* @__PURE__ */ f.jsx("code", { children: ul.id })], ["Branch", ul.branchLabel ?? "—"], ["Working tree", ul.dirtyLabel ?? "—"], ["Readiness", /* @__PURE__ */ f.jsx(Xl, { label: ul.readinessLabel ?? ul.statusLabel ?? "Registered", tone: ul.readinessLabel ?? ul.statusLabel })]] }),
        /* @__PURE__ */ f.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced registry metadata" }),
          /* @__PURE__ */ f.jsx("pre", { children: Pn(ul.advanced) })
        ] }),
        /* @__PURE__ */ f.jsx("div", { className: "detail-button-row", children: /* @__PURE__ */ f.jsx(wa, { className: "danger-text", disabled: x, onClick: () => {
          H(ul.id);
        }, children: "Remove registry entry" }) })
      ] }) })
    ] })
  ] });
}
function Vv({ data: r, busy: x, onRefresh: M, onProviderAction: o, onProviderHealth: H, onToolAction: C, onToolHealth: X }) {
  const Z = r.automationSettings;
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($a, { eyebrow: "LONG-LIVED CONFIG", title: "Settings", description: "模型、Provider 与本地工具的长期默认配置。Automation 调度不在这里。", refreshedAt: r.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ f.jsxs("div", { className: "settings-column", children: [
      (Z.warnings ?? []).map((O) => /* @__PURE__ */ f.jsx("div", { className: "detail-callout warning", children: O }, O)),
      /* @__PURE__ */ f.jsxs("section", { children: [
        /* @__PURE__ */ f.jsx(In, { title: "Models & routing", meta: `${Z.providers?.length ?? 0} providers` }),
        /* @__PURE__ */ f.jsx("div", { className: "settings-list", children: (Z.providers ?? []).map((O) => /* @__PURE__ */ f.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("strong", { children: O.displayName }),
            /* @__PURE__ */ f.jsx("p", { children: It(O.explanation ?? O.summary, 120) })
          ] }),
          /* @__PURE__ */ f.jsx(Xl, { label: O.statusLabel ?? O.status ?? "Unknown", tone: O.status }),
          /* @__PURE__ */ f.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ f.jsx(wa, { disabled: x, onClick: () => {
              H(O);
            }, children: "Check" }),
            /* @__PURE__ */ f.jsx(wa, { disabled: x, onClick: () => {
              o(O, O.enabled === !1 ? "enable" : "disable");
            }, children: O.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, O.providerId)) })
      ] }),
      /* @__PURE__ */ f.jsxs("section", { children: [
        /* @__PURE__ */ f.jsx(In, { title: "Local tools", meta: `${Z.localTools?.length ?? 0} configured` }),
        /* @__PURE__ */ f.jsx("div", { className: "settings-list", children: (Z.localTools ?? []).map((O) => /* @__PURE__ */ f.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("strong", { children: O.displayName }),
            /* @__PURE__ */ f.jsx("p", { children: It(O.summary, 120) })
          ] }),
          /* @__PURE__ */ f.jsx(Xl, { label: O.status ?? (O.enabled === !1 ? "Disabled" : "Configured"), tone: O.status }),
          /* @__PURE__ */ f.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ f.jsx(wa, { disabled: x, onClick: () => {
              X(O);
            }, children: "Check" }),
            /* @__PURE__ */ f.jsx(wa, { disabled: x, onClick: () => {
              C(O, O.enabled === !1 ? "enable" : "disable");
            }, children: O.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, O.toolId)) })
      ] }),
      /* @__PURE__ */ f.jsxs("details", { className: "advanced", children: [
        /* @__PURE__ */ f.jsx("summary", { children: "Advanced routing & credentials metadata" }),
        /* @__PURE__ */ f.jsx("pre", { children: Pn({ routing: Z.routing, credentials: Z.credentials, overview: Z.overview }) })
      ] })
    ] })
  ] });
}
function Kv({ data: r, busy: x, onRefresh: M }) {
  const [o, H] = Sl.useState(), C = r.commandCenter.readiness ?? {};
  return /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
    /* @__PURE__ */ f.jsx($a, { eyebrow: "MAINTENANCE", title: "System", description: "低频工程维护入口。正常使用 Forge 不需要理解这里的运行时细节。", refreshedAt: r.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ f.jsxs("div", { className: "system-layout", children: [
      /* @__PURE__ */ f.jsxs("section", { className: "system-summary", children: [
        /* @__PURE__ */ f.jsxs("div", { className: "system-posture", children: [
          /* @__PURE__ */ f.jsxs("div", { children: [
            /* @__PURE__ */ f.jsx("span", { className: "eyebrow", children: "SYSTEM POSTURE" }),
            /* @__PURE__ */ f.jsx("h2", { children: Ce(C.label ?? C.headline, "Controller state") }),
            /* @__PURE__ */ f.jsx("p", { children: Ce(C.explanation ?? C.summary, "Controller and connector status") })
          ] }),
          /* @__PURE__ */ f.jsx(Xl, { label: Ce(C.state, "Unknown"), tone: Ce(C.state) })
        ] }),
        /* @__PURE__ */ f.jsx(Du, { items: [["Controller", Ce(C.label ?? C.headline, "—")], ["Connector", Ce(r.connector?.status, "—")], ["Repositories", String(r.commandCenter.repositories?.length ?? 0)], ["Plugins", String(r.commandCenter.plugins?.length ?? 0)]] })
      ] }),
      /* @__PURE__ */ f.jsxs("section", { children: [
        /* @__PURE__ */ f.jsx("button", { className: "text-button", onClick: () => {
          dt.advanced().then(H);
        }, children: "Load advanced diagnostics" }),
        o && /* @__PURE__ */ f.jsxs("details", { className: "advanced", open: !0, children: [
          /* @__PURE__ */ f.jsx("summary", { children: "Advanced diagnostics" }),
          /* @__PURE__ */ f.jsx("pre", { children: Pn(o) })
        ] })
      ] })
    ] })
  ] });
}
async function Lm() {
  const [r, x, M, o, H] = await Promise.all([dt.commandCenter(), dt.work(), dt.automations(), dt.automationSettings(), dt.connector().catch(() => {
  })]);
  return { commandCenter: r, work: x, automations: M, automationSettings: o, connector: H, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function Jv() {
  const [r, x] = Sl.useState(Qm()), [M, o] = Sl.useState(), [H, C] = Sl.useState(!1), [X, Z] = Sl.useState(""), O = Sl.useCallback(async () => {
    C(!0), Z("");
    try {
      o(await Lm());
    } catch (_) {
      Z(_ instanceof Error ? _.message : String(_));
    } finally {
      C(!1);
    }
  }, []);
  Sl.useEffect(() => {
    O();
    const _ = () => x(Qm());
    return addEventListener("hashchange", _), () => removeEventListener("hashchange", _);
  }, [O]);
  const b = Sl.useCallback(async (_) => {
    C(!0);
    try {
      await _(), o(await Lm());
    } catch (ll) {
      Z(ll instanceof Error ? ll.message : String(ll));
    } finally {
      C(!1);
    }
  }, []);
  if (!M) return /* @__PURE__ */ f.jsxs("div", { className: "boot-state", children: [
    /* @__PURE__ */ f.jsx("span", { className: "brand-mark", children: "F" }),
    /* @__PURE__ */ f.jsx("strong", { children: X ? "Forge console unavailable" : "Loading Forge…" }),
    X && /* @__PURE__ */ f.jsxs(f.Fragment, { children: [
      /* @__PURE__ */ f.jsx("p", { children: X }),
      /* @__PURE__ */ f.jsx("button", { className: "button", onClick: () => {
        O();
      }, children: "Retry" })
    ] })
  ] });
  const N = { data: M, busy: H, onRefresh: () => {
    O();
  } };
  let A;
  switch (r) {
    case "automations":
      A = /* @__PURE__ */ f.jsx(Gv, { ...N, onAction: (_, ll) => b(() => dt.automationAction(_.source, _.repoId, _.id, ll)) });
      break;
    case "work":
      A = /* @__PURE__ */ f.jsx(Qv, { ...N });
      break;
    case "capabilities":
      A = /* @__PURE__ */ f.jsx(Xv, { ...N });
      break;
    case "repositories":
      A = /* @__PURE__ */ f.jsx(Zv, { ...N, onRegister: (_, ll) => b(() => dt.registerRepository(_, ll)), onRemove: (_) => b(() => dt.removeRepository(_)) });
      break;
    case "settings":
      A = /* @__PURE__ */ f.jsx(Vv, { ...N, onProviderAction: (_, ll) => b(() => dt.providerAction(_.providerId, ll)), onProviderHealth: (_) => b(() => dt.providerHealth(_.providerId)), onToolAction: (_, ll) => b(() => dt.localToolAction(_.toolId, ll)), onToolHealth: (_) => b(() => dt.localToolHealth(_.toolId)) });
      break;
    case "system":
      A = /* @__PURE__ */ f.jsx(Kv, { ...N });
      break;
    default:
      A = /* @__PURE__ */ f.jsx(Yv, { ...N });
  }
  return /* @__PURE__ */ f.jsxs(qv, { route: r, children: [
    X && /* @__PURE__ */ f.jsxs("div", { className: "global-error", children: [
      /* @__PURE__ */ f.jsx("strong", { children: "Last action failed" }),
      /* @__PURE__ */ f.jsx("span", { children: X }),
      /* @__PURE__ */ f.jsx("button", { onClick: () => Z(""), children: "×" })
    ] }),
    A
  ] });
}
const Vm = document.getElementById("app");
if (!Vm) throw new Error("Forge console root missing");
Tv.createRoot(Vm).render(/* @__PURE__ */ f.jsx(Sl.StrictMode, { children: /* @__PURE__ */ f.jsx(Jv, {}) }));
