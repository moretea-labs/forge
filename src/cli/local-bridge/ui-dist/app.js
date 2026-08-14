var pf = { exports: {} }, _u = {};
var Mr;
function hv() {
  if (Mr) return _u;
  Mr = 1;
  var m = /* @__PURE__ */ Symbol.for("react.transitional.element"), x = /* @__PURE__ */ Symbol.for("react.fragment");
  function M(o, H, R) {
    var X = null;
    if (R !== void 0 && (X = "" + R), H.key !== void 0 && (X = "" + H.key), "key" in H) {
      R = {};
      for (var Z in H)
        Z !== "key" && (R[Z] = H[Z]);
    } else R = H;
    return H = R.ref, {
      $$typeof: m,
      type: o,
      key: X,
      ref: H !== void 0 ? H : null,
      props: R
    };
  }
  return _u.Fragment = x, _u.jsx = M, _u.jsxs = M, _u;
}
var Dr;
function vv() {
  return Dr || (Dr = 1, pf.exports = hv()), pf.exports;
}
var c = vv(), jf = { exports: {} }, L = {};
var Ur;
function yv() {
  if (Ur) return L;
  Ur = 1;
  var m = /* @__PURE__ */ Symbol.for("react.transitional.element"), x = /* @__PURE__ */ Symbol.for("react.portal"), M = /* @__PURE__ */ Symbol.for("react.fragment"), o = /* @__PURE__ */ Symbol.for("react.strict_mode"), H = /* @__PURE__ */ Symbol.for("react.profiler"), R = /* @__PURE__ */ Symbol.for("react.consumer"), X = /* @__PURE__ */ Symbol.for("react.context"), Z = /* @__PURE__ */ Symbol.for("react.forward_ref"), N = /* @__PURE__ */ Symbol.for("react.suspense"), b = /* @__PURE__ */ Symbol.for("react.memo"), _ = /* @__PURE__ */ Symbol.for("react.lazy"), j = /* @__PURE__ */ Symbol.for("react.activity"), O = Symbol.iterator;
  function ul(r) {
    return r === null || typeof r != "object" ? null : (r = O && r[O] || r["@@iterator"], typeof r == "function" ? r : null);
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
  }, k = Object.assign, xl = {};
  function cl(r, E, U) {
    this.props = r, this.context = E, this.refs = xl, this.updater = U || El;
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
  function P() {
  }
  P.prototype = cl.prototype;
  function Gl(r, E, U) {
    this.props = r, this.context = E, this.refs = xl, this.updater = U || El;
  }
  var rt = Gl.prototype = new P();
  rt.constructor = Gl, k(rt, cl.prototype), rt.isPureReactComponent = !0;
  var Nt = Array.isArray;
  function Vl() {
  }
  var ll = { H: null, A: null, T: null, S: null }, Kl = Object.prototype.hasOwnProperty;
  function _t(r, E, U) {
    var q = U.ref;
    return {
      $$typeof: m,
      type: r,
      key: E,
      ref: q !== void 0 ? q : null,
      props: U
    };
  }
  function We(r, E) {
    return _t(r.type, E, r.props);
  }
  function Ot(r) {
    return typeof r == "object" && r !== null && r.$$typeof === m;
  }
  function Jl(r) {
    var E = { "=": "=0", ":": "=2" };
    return "$" + r.replace(/[=:]/g, function(U) {
      return E[U];
    });
  }
  var Ne = /\/+/g;
  function Ht(r, E) {
    return typeof r == "object" && r !== null && r.key != null ? Jl("" + r.key) : E.toString(36);
  }
  function zt(r) {
    switch (r.status) {
      case "fulfilled":
        return r.value;
      case "rejected":
        throw r.reason;
      default:
        switch (typeof r.status == "string" ? r.then(Vl, Vl) : (r.status = "pending", r.then(
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
  function A(r, E, U, q, V) {
    var w = typeof r;
    (w === "undefined" || w === "boolean") && (r = null);
    var il = !1;
    if (r === null) il = !0;
    else
      switch (w) {
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
            case _:
              return il = r._init, A(
                il(r._payload),
                E,
                U,
                q,
                V
              );
          }
      }
    if (il)
      return V = V(r), il = q === "" ? "." + Ht(r, 0) : q, Nt(V) ? (U = "", il != null && (U = il.replace(Ne, "$&/") + "/"), A(V, E, U, "", function(Ha) {
        return Ha;
      })) : V != null && (Ot(V) && (V = We(
        V,
        U + (V.key == null || r && r.key === V.key ? "" : ("" + V.key).replace(
          Ne,
          "$&/"
        ) + "/") + il
      )), E.push(V)), 1;
    il = 0;
    var Ll = q === "" ? "." : q + ":";
    if (Nt(r))
      for (var Al = 0; Al < r.length; Al++)
        q = r[Al], w = Ll + Ht(q, Al), il += A(
          q,
          E,
          U,
          w,
          V
        );
    else if (Al = ul(r), typeof Al == "function")
      for (r = Al.call(r), Al = 0; !(q = r.next()).done; )
        q = q.value, w = Ll + Ht(q, Al++), il += A(
          q,
          E,
          U,
          w,
          V
        );
    else if (w === "object") {
      if (typeof r.then == "function")
        return A(
          zt(r),
          E,
          U,
          q,
          V
        );
      throw E = String(r), Error(
        "Objects are not valid as a React child (found: " + (E === "[object Object]" ? "object with keys {" + Object.keys(r).join(", ") + "}" : E) + "). If you meant to render a collection of children, use an array instead."
      );
    }
    return il;
  }
  function D(r, E, U) {
    if (r == null) return r;
    var q = [], V = 0;
    return A(r, q, "", "", function(w) {
      return E.call(U, w, V++);
    }), q;
  }
  function Q(r) {
    if (r._status === -1) {
      var E = r._result;
      E = E(), E.then(
        function(U) {
          (r._status === 0 || r._status === -1) && (r._status = 1, r._result = U);
        },
        function(U) {
          (r._status === 0 || r._status === -1) && (r._status = 2, r._result = U);
        }
      ), r._status === -1 && (r._status = 0, r._result = E);
    }
    if (r._status === 1) return r._result.default;
    throw r._result;
  }
  var dl = typeof reportError == "function" ? reportError : function(r) {
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
    map: D,
    forEach: function(r, E, U) {
      D(
        r,
        function() {
          E.apply(this, arguments);
        },
        U
      );
    },
    count: function(r) {
      var E = 0;
      return D(r, function() {
        E++;
      }), E;
    },
    toArray: function(r) {
      return D(r, function(E) {
        return E;
      }) || [];
    },
    only: function(r) {
      if (!Ot(r))
        throw Error(
          "React.Children.only expected to receive a single React element child."
        );
      return r;
    }
  };
  return L.Activity = j, L.Children = hl, L.Component = cl, L.Fragment = M, L.Profiler = H, L.PureComponent = Gl, L.StrictMode = o, L.Suspense = N, L.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ll, L.__COMPILER_RUNTIME = {
    __proto__: null,
    c: function(r) {
      return ll.H.useMemoCache(r);
    }
  }, L.cache = function(r) {
    return function() {
      return r.apply(null, arguments);
    };
  }, L.cacheSignal = function() {
    return null;
  }, L.cloneElement = function(r, E, U) {
    if (r == null)
      throw Error(
        "The argument must be a React element, but you passed " + r + "."
      );
    var q = k({}, r.props), V = r.key;
    if (E != null)
      for (w in E.key !== void 0 && (V = "" + E.key), E)
        !Kl.call(E, w) || w === "key" || w === "__self" || w === "__source" || w === "ref" && E.ref === void 0 || (q[w] = E[w]);
    var w = arguments.length - 2;
    if (w === 1) q.children = U;
    else if (1 < w) {
      for (var il = Array(w), Ll = 0; Ll < w; Ll++)
        il[Ll] = arguments[Ll + 2];
      q.children = il;
    }
    return _t(r.type, V, q);
  }, L.createContext = function(r) {
    return r = {
      $$typeof: X,
      _currentValue: r,
      _currentValue2: r,
      _threadCount: 0,
      Provider: null,
      Consumer: null
    }, r.Provider = r, r.Consumer = {
      $$typeof: R,
      _context: r
    }, r;
  }, L.createElement = function(r, E, U) {
    var q, V = {}, w = null;
    if (E != null)
      for (q in E.key !== void 0 && (w = "" + E.key), E)
        Kl.call(E, q) && q !== "key" && q !== "__self" && q !== "__source" && (V[q] = E[q]);
    var il = arguments.length - 2;
    if (il === 1) V.children = U;
    else if (1 < il) {
      for (var Ll = Array(il), Al = 0; Al < il; Al++)
        Ll[Al] = arguments[Al + 2];
      V.children = Ll;
    }
    if (r && r.defaultProps)
      for (q in il = r.defaultProps, il)
        V[q] === void 0 && (V[q] = il[q]);
    return _t(r, w, V);
  }, L.createRef = function() {
    return { current: null };
  }, L.forwardRef = function(r) {
    return { $$typeof: Z, render: r };
  }, L.isValidElement = Ot, L.lazy = function(r) {
    return {
      $$typeof: _,
      _payload: { _status: -1, _result: r },
      _init: Q
    };
  }, L.memo = function(r, E) {
    return {
      $$typeof: b,
      type: r,
      compare: E === void 0 ? null : E
    };
  }, L.startTransition = function(r) {
    var E = ll.T, U = {};
    ll.T = U;
    try {
      var q = r(), V = ll.S;
      V !== null && V(U, q), typeof q == "object" && q !== null && typeof q.then == "function" && q.then(Vl, dl);
    } catch (w) {
      dl(w);
    } finally {
      E !== null && U.types !== null && (E.types = U.types), ll.T = E;
    }
  }, L.unstable_useCacheRefresh = function() {
    return ll.H.useCacheRefresh();
  }, L.use = function(r) {
    return ll.H.use(r);
  }, L.useActionState = function(r, E, U) {
    return ll.H.useActionState(r, E, U);
  }, L.useCallback = function(r, E) {
    return ll.H.useCallback(r, E);
  }, L.useContext = function(r) {
    return ll.H.useContext(r);
  }, L.useDebugValue = function() {
  }, L.useDeferredValue = function(r, E) {
    return ll.H.useDeferredValue(r, E);
  }, L.useEffect = function(r, E) {
    return ll.H.useEffect(r, E);
  }, L.useEffectEvent = function(r) {
    return ll.H.useEffectEvent(r);
  }, L.useId = function() {
    return ll.H.useId();
  }, L.useImperativeHandle = function(r, E, U) {
    return ll.H.useImperativeHandle(r, E, U);
  }, L.useInsertionEffect = function(r, E) {
    return ll.H.useInsertionEffect(r, E);
  }, L.useLayoutEffect = function(r, E) {
    return ll.H.useLayoutEffect(r, E);
  }, L.useMemo = function(r, E) {
    return ll.H.useMemo(r, E);
  }, L.useOptimistic = function(r, E) {
    return ll.H.useOptimistic(r, E);
  }, L.useReducer = function(r, E, U) {
    return ll.H.useReducer(r, E, U);
  }, L.useRef = function(r) {
    return ll.H.useRef(r);
  }, L.useState = function(r) {
    return ll.H.useState(r);
  }, L.useSyncExternalStore = function(r, E, U) {
    return ll.H.useSyncExternalStore(
      r,
      E,
      U
    );
  }, L.useTransition = function() {
    return ll.H.useTransition();
  }, L.version = "19.2.8", L;
}
var Rr;
function xf() {
  return Rr || (Rr = 1, jf.exports = yv()), jf.exports;
}
var bl = xf(), Af = { exports: {} }, Ou = {}, zf = { exports: {} }, Tf = {};
var Cr;
function gv() {
  return Cr || (Cr = 1, (function(m) {
    function x(A, D) {
      var Q = A.length;
      A.push(D);
      l: for (; 0 < Q; ) {
        var dl = Q - 1 >>> 1, hl = A[dl];
        if (0 < H(hl, D))
          A[dl] = D, A[Q] = hl, Q = dl;
        else break l;
      }
    }
    function M(A) {
      return A.length === 0 ? null : A[0];
    }
    function o(A) {
      if (A.length === 0) return null;
      var D = A[0], Q = A.pop();
      if (Q !== D) {
        A[0] = Q;
        l: for (var dl = 0, hl = A.length, r = hl >>> 1; dl < r; ) {
          var E = 2 * (dl + 1) - 1, U = A[E], q = E + 1, V = A[q];
          if (0 > H(U, Q))
            q < hl && 0 > H(V, U) ? (A[dl] = V, A[q] = Q, dl = q) : (A[dl] = U, A[E] = Q, dl = E);
          else if (q < hl && 0 > H(V, Q))
            A[dl] = V, A[q] = Q, dl = q;
          else break l;
        }
      }
      return D;
    }
    function H(A, D) {
      var Q = A.sortIndex - D.sortIndex;
      return Q !== 0 ? Q : A.id - D.id;
    }
    if (m.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
      var R = performance;
      m.unstable_now = function() {
        return R.now();
      };
    } else {
      var X = Date, Z = X.now();
      m.unstable_now = function() {
        return X.now() - Z;
      };
    }
    var N = [], b = [], _ = 1, j = null, O = 3, ul = !1, El = !1, k = !1, xl = !1, cl = typeof setTimeout == "function" ? setTimeout : null, P = typeof clearTimeout == "function" ? clearTimeout : null, Gl = typeof setImmediate < "u" ? setImmediate : null;
    function rt(A) {
      for (var D = M(b); D !== null; ) {
        if (D.callback === null) o(b);
        else if (D.startTime <= A)
          o(b), D.sortIndex = D.expirationTime, x(N, D);
        else break;
        D = M(b);
      }
    }
    function Nt(A) {
      if (k = !1, rt(A), !El)
        if (M(N) !== null)
          El = !0, Vl || (Vl = !0, Jl());
        else {
          var D = M(b);
          D !== null && zt(Nt, D.startTime - A);
        }
    }
    var Vl = !1, ll = -1, Kl = 5, _t = -1;
    function We() {
      return xl ? !0 : !(m.unstable_now() - _t < Kl);
    }
    function Ot() {
      if (xl = !1, Vl) {
        var A = m.unstable_now();
        _t = A;
        var D = !0;
        try {
          l: {
            El = !1, k && (k = !1, P(ll), ll = -1), ul = !0;
            var Q = O;
            try {
              t: {
                for (rt(A), j = M(N); j !== null && !(j.expirationTime > A && We()); ) {
                  var dl = j.callback;
                  if (typeof dl == "function") {
                    j.callback = null, O = j.priorityLevel;
                    var hl = dl(
                      j.expirationTime <= A
                    );
                    if (A = m.unstable_now(), typeof hl == "function") {
                      j.callback = hl, rt(A), D = !0;
                      break t;
                    }
                    j === M(N) && o(N), rt(A);
                  } else o(N);
                  j = M(N);
                }
                if (j !== null) D = !0;
                else {
                  var r = M(b);
                  r !== null && zt(
                    Nt,
                    r.startTime - A
                  ), D = !1;
                }
              }
              break l;
            } finally {
              j = null, O = Q, ul = !1;
            }
            D = void 0;
          }
        } finally {
          D ? Jl() : Vl = !1;
        }
      }
    }
    var Jl;
    if (typeof Gl == "function")
      Jl = function() {
        Gl(Ot);
      };
    else if (typeof MessageChannel < "u") {
      var Ne = new MessageChannel(), Ht = Ne.port2;
      Ne.port1.onmessage = Ot, Jl = function() {
        Ht.postMessage(null);
      };
    } else
      Jl = function() {
        cl(Ot, 0);
      };
    function zt(A, D) {
      ll = cl(function() {
        A(m.unstable_now());
      }, D);
    }
    m.unstable_IdlePriority = 5, m.unstable_ImmediatePriority = 1, m.unstable_LowPriority = 4, m.unstable_NormalPriority = 3, m.unstable_Profiling = null, m.unstable_UserBlockingPriority = 2, m.unstable_cancelCallback = function(A) {
      A.callback = null;
    }, m.unstable_forceFrameRate = function(A) {
      0 > A || 125 < A ? console.error(
        "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
      ) : Kl = 0 < A ? Math.floor(1e3 / A) : 5;
    }, m.unstable_getCurrentPriorityLevel = function() {
      return O;
    }, m.unstable_next = function(A) {
      switch (O) {
        case 1:
        case 2:
        case 3:
          var D = 3;
          break;
        default:
          D = O;
      }
      var Q = O;
      O = D;
      try {
        return A();
      } finally {
        O = Q;
      }
    }, m.unstable_requestPaint = function() {
      xl = !0;
    }, m.unstable_runWithPriority = function(A, D) {
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
      var Q = O;
      O = A;
      try {
        return D();
      } finally {
        O = Q;
      }
    }, m.unstable_scheduleCallback = function(A, D, Q) {
      var dl = m.unstable_now();
      switch (typeof Q == "object" && Q !== null ? (Q = Q.delay, Q = typeof Q == "number" && 0 < Q ? dl + Q : dl) : Q = dl, A) {
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
      return hl = Q + hl, A = {
        id: _++,
        callback: D,
        priorityLevel: A,
        startTime: Q,
        expirationTime: hl,
        sortIndex: -1
      }, Q > dl ? (A.sortIndex = Q, x(b, A), M(N) === null && A === M(b) && (k ? (P(ll), ll = -1) : k = !0, zt(Nt, Q - dl))) : (A.sortIndex = hl, x(N, A), El || ul || (El = !0, Vl || (Vl = !0, Jl()))), A;
    }, m.unstable_shouldYield = We, m.unstable_wrapCallback = function(A) {
      var D = O;
      return function() {
        var Q = O;
        O = D;
        try {
          return A.apply(this, arguments);
        } finally {
          O = Q;
        }
      };
    };
  })(Tf)), Tf;
}
var Hr;
function Sv() {
  return Hr || (Hr = 1, zf.exports = gv()), zf.exports;
}
var Ef = { exports: {} }, Ql = {};
var qr;
function bv() {
  if (qr) return Ql;
  qr = 1;
  var m = xf();
  function x(N) {
    var b = "https://react.dev/errors/" + N;
    if (1 < arguments.length) {
      b += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var _ = 2; _ < arguments.length; _++)
        b += "&args[]=" + encodeURIComponent(arguments[_]);
    }
    return "Minified React error #" + N + "; visit " + b + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
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
  function R(N, b, _) {
    var j = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: H,
      key: j == null ? null : "" + j,
      children: N,
      containerInfo: b,
      implementation: _
    };
  }
  var X = m.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function Z(N, b) {
    if (N === "font") return "";
    if (typeof b == "string")
      return b === "use-credentials" ? b : "";
  }
  return Ql.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = o, Ql.createPortal = function(N, b) {
    var _ = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!b || b.nodeType !== 1 && b.nodeType !== 9 && b.nodeType !== 11)
      throw Error(x(299));
    return R(N, b, null, _);
  }, Ql.flushSync = function(N) {
    var b = X.T, _ = o.p;
    try {
      if (X.T = null, o.p = 2, N) return N();
    } finally {
      X.T = b, o.p = _, o.d.f();
    }
  }, Ql.preconnect = function(N, b) {
    typeof N == "string" && (b ? (b = b.crossOrigin, b = typeof b == "string" ? b === "use-credentials" ? b : "" : void 0) : b = null, o.d.C(N, b));
  }, Ql.prefetchDNS = function(N) {
    typeof N == "string" && o.d.D(N);
  }, Ql.preinit = function(N, b) {
    if (typeof N == "string" && b && typeof b.as == "string") {
      var _ = b.as, j = Z(_, b.crossOrigin), O = typeof b.integrity == "string" ? b.integrity : void 0, ul = typeof b.fetchPriority == "string" ? b.fetchPriority : void 0;
      _ === "style" ? o.d.S(
        N,
        typeof b.precedence == "string" ? b.precedence : void 0,
        {
          crossOrigin: j,
          integrity: O,
          fetchPriority: ul
        }
      ) : _ === "script" && o.d.X(N, {
        crossOrigin: j,
        integrity: O,
        fetchPriority: ul,
        nonce: typeof b.nonce == "string" ? b.nonce : void 0
      });
    }
  }, Ql.preinitModule = function(N, b) {
    if (typeof N == "string")
      if (typeof b == "object" && b !== null) {
        if (b.as == null || b.as === "script") {
          var _ = Z(
            b.as,
            b.crossOrigin
          );
          o.d.M(N, {
            crossOrigin: _,
            integrity: typeof b.integrity == "string" ? b.integrity : void 0,
            nonce: typeof b.nonce == "string" ? b.nonce : void 0
          });
        }
      } else b == null && o.d.M(N);
  }, Ql.preload = function(N, b) {
    if (typeof N == "string" && typeof b == "object" && b !== null && typeof b.as == "string") {
      var _ = b.as, j = Z(_, b.crossOrigin);
      o.d.L(N, _, {
        crossOrigin: j,
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
  }, Ql.preloadModule = function(N, b) {
    if (typeof N == "string")
      if (b) {
        var _ = Z(b.as, b.crossOrigin);
        o.d.m(N, {
          as: typeof b.as == "string" && b.as !== "script" ? b.as : void 0,
          crossOrigin: _,
          integrity: typeof b.integrity == "string" ? b.integrity : void 0
        });
      } else o.d.m(N);
  }, Ql.requestFormReset = function(N) {
    o.d.r(N);
  }, Ql.unstable_batchedUpdates = function(N, b) {
    return N(b);
  }, Ql.useFormState = function(N, b, _) {
    return X.H.useFormState(N, b, _);
  }, Ql.useFormStatus = function() {
    return X.H.useHostTransitionStatus();
  }, Ql.version = "19.2.8", Ql;
}
var Br;
function pv() {
  if (Br) return Ef.exports;
  Br = 1;
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
var Yr;
function jv() {
  if (Yr) return Ou;
  Yr = 1;
  var m = Sv(), x = xf(), M = pv();
  function o(l) {
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
  function R(l) {
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
  function Z(l) {
    if (l.tag === 31) {
      var t = l.memoizedState;
      if (t === null && (l = l.alternate, l !== null && (t = l.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function N(l) {
    if (R(l) !== l)
      throw Error(o(188));
  }
  function b(l) {
    var t = l.alternate;
    if (!t) {
      if (t = R(l), t === null) throw Error(o(188));
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
  function _(l) {
    var t = l.tag;
    if (t === 5 || t === 26 || t === 27 || t === 6) return l;
    for (l = l.child; l !== null; ) {
      if (t = _(l), t !== null) return t;
      l = l.sibling;
    }
    return null;
  }
  var j = Object.assign, O = /* @__PURE__ */ Symbol.for("react.element"), ul = /* @__PURE__ */ Symbol.for("react.transitional.element"), El = /* @__PURE__ */ Symbol.for("react.portal"), k = /* @__PURE__ */ Symbol.for("react.fragment"), xl = /* @__PURE__ */ Symbol.for("react.strict_mode"), cl = /* @__PURE__ */ Symbol.for("react.profiler"), P = /* @__PURE__ */ Symbol.for("react.consumer"), Gl = /* @__PURE__ */ Symbol.for("react.context"), rt = /* @__PURE__ */ Symbol.for("react.forward_ref"), Nt = /* @__PURE__ */ Symbol.for("react.suspense"), Vl = /* @__PURE__ */ Symbol.for("react.suspense_list"), ll = /* @__PURE__ */ Symbol.for("react.memo"), Kl = /* @__PURE__ */ Symbol.for("react.lazy"), _t = /* @__PURE__ */ Symbol.for("react.activity"), We = /* @__PURE__ */ Symbol.for("react.memo_cache_sentinel"), Ot = Symbol.iterator;
  function Jl(l) {
    return l === null || typeof l != "object" ? null : (l = Ot && l[Ot] || l["@@iterator"], typeof l == "function" ? l : null);
  }
  var Ne = /* @__PURE__ */ Symbol.for("react.client.reference");
  function Ht(l) {
    if (l == null) return null;
    if (typeof l == "function")
      return l.$$typeof === Ne ? null : l.displayName || l.name || null;
    if (typeof l == "string") return l;
    switch (l) {
      case k:
        return "Fragment";
      case cl:
        return "Profiler";
      case xl:
        return "StrictMode";
      case Nt:
        return "Suspense";
      case Vl:
        return "SuspenseList";
      case _t:
        return "Activity";
    }
    if (typeof l == "object")
      switch (l.$$typeof) {
        case El:
          return "Portal";
        case Gl:
          return l.displayName || "Context";
        case P:
          return (l._context.displayName || "Context") + ".Consumer";
        case rt:
          var t = l.render;
          return l = l.displayName, l || (l = t.displayName || t.name || "", l = l !== "" ? "ForwardRef(" + l + ")" : "ForwardRef"), l;
        case ll:
          return t = l.displayName || null, t !== null ? t : Ht(l.type) || "Memo";
        case Kl:
          t = l._payload, l = l._init;
          try {
            return Ht(l(t));
          } catch {
          }
      }
    return null;
  }
  var zt = Array.isArray, A = x.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, D = M.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, Q = {
    pending: !1,
    data: null,
    method: null,
    action: null
  }, dl = [], hl = -1;
  function r(l) {
    return { current: l };
  }
  function E(l) {
    0 > hl || (l.current = dl[hl], dl[hl] = null, hl--);
  }
  function U(l, t) {
    hl++, dl[hl] = l.current, l.current = t;
  }
  var q = r(null), V = r(null), w = r(null), il = r(null);
  function Ll(l, t) {
    switch (U(w, t), U(V, l), U(q, null), t.nodeType) {
      case 9:
      case 11:
        l = (l = t.documentElement) && (l = l.namespaceURI) ? Po(l) : 0;
        break;
      default:
        if (l = t.tagName, t = t.namespaceURI)
          t = Po(t), l = lr(t, l);
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
  function Al() {
    E(q), E(V), E(w);
  }
  function Ha(l) {
    l.memoizedState !== null && U(il, l);
    var t = q.current, e = lr(t, l.type);
    t !== e && (U(V, l), U(q, e));
  }
  function Uu(l) {
    V.current === l && (E(q), E(V)), il.current === l && (E(il), Tu._currentValue = Q);
  }
  var ti, _f;
  function _e(l) {
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
                  var p = `
` + s[a].replace(" at new ", " at ");
                  return l.displayName && p.includes("<anonymous>") && (p = p.replace("<anonymous>", l.displayName)), p;
                }
              while (1 <= a && 0 <= u);
            break;
          }
      }
    } finally {
      ei = !1, Error.prepareStackTrace = e;
    }
    return (e = l ? l.displayName || l.name : "") ? _e(e) : "";
  }
  function Kr(l, t) {
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
        return ai(l.type, !1);
      case 11:
        return ai(l.type.render, !1);
      case 1:
        return ai(l.type, !0);
      case 31:
        return _e("Activity");
      default:
        return "";
    }
  }
  function Of(l) {
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
  var ui = Object.prototype.hasOwnProperty, ni = m.unstable_scheduleCallback, ii = m.unstable_cancelCallback, Jr = m.unstable_shouldYield, wr = m.unstable_requestPaint, lt = m.unstable_now, $r = m.unstable_getCurrentPriorityLevel, Mf = m.unstable_ImmediatePriority, Df = m.unstable_UserBlockingPriority, Ru = m.unstable_NormalPriority, Wr = m.unstable_LowPriority, Uf = m.unstable_IdlePriority, kr = m.log, Fr = m.unstable_setDisableYieldValue, qa = null, tt = null;
  function te(l) {
    if (typeof kr == "function" && Fr(l), tt && typeof tt.setStrictMode == "function")
      try {
        tt.setStrictMode(qa, l);
      } catch {
      }
  }
  var et = Math.clz32 ? Math.clz32 : lm, Ir = Math.log, Pr = Math.LN2;
  function lm(l) {
    return l >>>= 0, l === 0 ? 32 : 31 - (Ir(l) / Pr | 0) | 0;
  }
  var Cu = 256, Hu = 262144, qu = 4194304;
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
  function Bu(l, t, e) {
    var a = l.pendingLanes;
    if (a === 0) return 0;
    var u = 0, n = l.suspendedLanes, i = l.pingedLanes;
    l = l.warmLanes;
    var f = a & 134217727;
    return f !== 0 ? (a = f & ~n, a !== 0 ? u = Oe(a) : (i &= f, i !== 0 ? u = Oe(i) : e || (e = f & ~l, e !== 0 && (u = Oe(e))))) : (f = a & ~n, f !== 0 ? u = Oe(f) : i !== 0 ? u = Oe(i) : e || (e = a & ~l, e !== 0 && (u = Oe(e)))), u === 0 ? 0 : t !== 0 && t !== u && (t & n) === 0 && (n = u & -u, e = t & -t, n >= e || n === 32 && (e & 4194048) !== 0) ? t : u;
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
  function Rf() {
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
    var f = l.entanglements, s = l.expirationTimes, y = l.hiddenUpdates;
    for (e = i & ~e; 0 < e; ) {
      var p = 31 - et(e), T = 1 << p;
      f[p] = 0, s[p] = -1;
      var g = y[p];
      if (g !== null)
        for (y[p] = null, p = 0; p < g.length; p++) {
          var S = g[p];
          S !== null && (S.lane &= -536870913);
        }
      e &= ~T;
    }
    a !== 0 && Cf(l, a, 0), n !== 0 && u === 0 && l.tag !== 0 && (l.suspendedLanes |= n & ~(i & ~t));
  }
  function Cf(l, t, e) {
    l.pendingLanes |= t, l.suspendedLanes &= ~t;
    var a = 31 - et(t);
    l.entangledLanes |= t, l.entanglements[a] = l.entanglements[a] | 1073741824 | e & 261930;
  }
  function Hf(l, t) {
    var e = l.entangledLanes |= t;
    for (l = l.entanglements; e; ) {
      var a = 31 - et(e), u = 1 << a;
      u & t | l[a] & t && (l[a] |= t), e &= ~u;
    }
  }
  function qf(l, t) {
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
  function Bf() {
    var l = D.p;
    return l !== 0 ? l : (l = window.event, l === void 0 ? 32 : zr(l.type));
  }
  function Yf(l, t) {
    var e = D.p;
    try {
      return D.p = l, t();
    } finally {
      D.p = e;
    }
  }
  var ee = Math.random().toString(36).slice(2), Cl = "__reactFiber$" + ee, wl = "__reactProps$" + ee, ke = "__reactContainer$" + ee, di = "__reactEvents$" + ee, am = "__reactListeners$" + ee, um = "__reactHandles$" + ee, Gf = "__reactResources$" + ee, Ga = "__reactMarker$" + ee;
  function oi(l) {
    delete l[Cl], delete l[wl], delete l[di], delete l[am], delete l[um];
  }
  function Fe(l) {
    var t = l[Cl];
    if (t) return t;
    for (var e = l.parentNode; e; ) {
      if (t = e[ke] || e[Cl]) {
        if (e = t.alternate, t.child !== null || e !== null && e.child !== null)
          for (l = cr(l); l !== null; ) {
            if (e = l[Cl]) return e;
            l = cr(l);
          }
        return t;
      }
      l = e, e = l.parentNode;
    }
    return null;
  }
  function Ie(l) {
    if (l = l[Cl] || l[ke]) {
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
    var t = l[Gf];
    return t || (t = l[Gf] = { hoistableStyles: /* @__PURE__ */ new Map(), hoistableScripts: /* @__PURE__ */ new Map() }), t;
  }
  function Ul(l) {
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
  var nm = RegExp(
    "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"
  ), Lf = {}, Zf = {};
  function im(l) {
    return ui.call(Zf, l) ? !0 : ui.call(Lf, l) ? !1 : nm.test(l) ? Zf[l] = !0 : (Lf[l] = !0, !1);
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
      var t = Vf(l) ? "checked" : "value";
      l._valueTracker = cm(
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
  function Qu(l) {
    if (l = l || (typeof document < "u" ? document : void 0), typeof l > "u") return null;
    try {
      return l.activeElement || l.body;
    } catch {
      return l.body;
    }
  }
  var fm = /[\n"\\]/g;
  function ht(l) {
    return l.replace(
      fm,
      function(t) {
        return "\\" + t.charCodeAt(0).toString(16) + " ";
      }
    );
  }
  function mi(l, t, e, a, u, n, i, f) {
    l.name = "", i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" ? l.type = i : l.removeAttribute("type"), t != null ? i === "number" ? (t === 0 && l.value === "" || l.value != t) && (l.value = "" + mt(t)) : l.value !== "" + mt(t) && (l.value = "" + mt(t)) : i !== "submit" && i !== "reset" || l.removeAttribute("value"), t != null ? hi(l, i, mt(t)) : e != null ? hi(l, i, mt(e)) : a != null && l.removeAttribute("value"), u == null && n != null && (l.defaultChecked = !!n), u != null && (l.checked = u && typeof u != "function" && typeof u != "symbol"), f != null && typeof f != "function" && typeof f != "symbol" && typeof f != "boolean" ? l.name = "" + mt(f) : l.removeAttribute("name");
  }
  function Jf(l, t, e, a, u, n, i, f) {
    if (n != null && typeof n != "function" && typeof n != "symbol" && typeof n != "boolean" && (l.type = n), t != null || e != null) {
      if (!(n !== "submit" && n !== "reset" || t != null)) {
        ri(l);
        return;
      }
      e = e != null ? "" + mt(e) : "", t = t != null ? "" + mt(t) : e, f || t === l.value || (l.value = t), l.defaultValue = t;
    }
    a = a ?? u, a = typeof a != "function" && typeof a != "symbol" && !!a, l.checked = f ? l.checked : !!a, l.defaultChecked = !!a, i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" && (l.name = i), ri(l);
  }
  function hi(l, t, e) {
    t === "number" && Qu(l.ownerDocument) === l || l.defaultValue === "" + e || (l.defaultValue = "" + e);
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
        if (e != null) throw Error(o(92));
        if (zt(a)) {
          if (1 < a.length) throw Error(o(93));
          a = a[0];
        }
        e = a;
      }
      e == null && (e = ""), t = e;
    }
    e = mt(t), l.defaultValue = e, a = l.textContent, a === e && a !== "" && a !== null && (l.value = a), ri(l);
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
  function Wf(l, t, e) {
    var a = t.indexOf("--") === 0;
    e == null || typeof e == "boolean" || e === "" ? a ? l.setProperty(t, "") : t === "float" ? l.cssFloat = "" : l[t] = "" : a ? l.setProperty(t, e) : typeof e != "number" || e === 0 || sm.has(t) ? t === "float" ? l.cssFloat = e : l[t] = ("" + e).trim() : l[t] = e + "px";
  }
  function kf(l, t, e) {
    if (t != null && typeof t != "object")
      throw Error(o(62));
    if (l = l.style, e != null) {
      for (var a in e)
        !e.hasOwnProperty(a) || t != null && t.hasOwnProperty(a) || (a.indexOf("--") === 0 ? l.setProperty(a, "") : a === "float" ? l.cssFloat = "" : l[a] = "");
      for (var u in t)
        a = t[u], t.hasOwnProperty(u) && e[u] !== a && Wf(l, u, a);
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
  var dm = /* @__PURE__ */ new Map([
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
  ]), om = /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function Xu(l) {
    return om.test("" + l) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : l;
  }
  function Bt() {
  }
  var yi = null;
  function gi(l) {
    return l = l.target || l.srcElement || window, l.correspondingUseElement && (l = l.correspondingUseElement), l.nodeType === 3 ? l.parentNode : l;
  }
  var aa = null, ua = null;
  function Ff(l) {
    var t = Ie(l);
    if (t && (l = t.stateNode)) {
      var e = l[wl] || null;
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
              'input[name="' + ht(
                "" + t
              ) + '"][type="radio"]'
            ), t = 0; t < e.length; t++) {
              var a = e[t];
              if (a !== l && a.form === l.form) {
                var u = a[wl] || null;
                if (!u) throw Error(o(90));
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
              a = e[t], a.form === l.form && Kf(a);
          }
          break l;
        case "textarea":
          wf(l, e.value, e.defaultValue);
          break l;
        case "select":
          t = e.value, t != null && ta(l, !!e.multiple, t, !1);
      }
    }
  }
  var Si = !1;
  function If(l, t, e) {
    if (Si) return l(t, e);
    Si = !0;
    try {
      var a = l(t);
      return a;
    } finally {
      if (Si = !1, (aa !== null || ua !== null) && (On(), aa && (t = aa, l = ua, ua = aa = null, Ff(t), l)))
        for (t = 0; t < l.length; t++) Ff(l[t]);
    }
  }
  function Xa(l, t) {
    var e = l.stateNode;
    if (e === null) return null;
    var a = e[wl] || null;
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
  var Yt = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), bi = !1;
  if (Yt)
    try {
      var La = {};
      Object.defineProperty(La, "passive", {
        get: function() {
          bi = !0;
        }
      }), window.addEventListener("test", La, La), window.removeEventListener("test", La, La);
    } catch {
      bi = !1;
    }
  var ae = null, pi = null, Lu = null;
  function Pf() {
    if (Lu) return Lu;
    var l, t = pi, e = t.length, a, u = "value" in ae ? ae.value : ae.textContent, n = u.length;
    for (l = 0; l < e && t[l] === u[l]; l++) ;
    var i = e - l;
    for (a = 1; a <= i && t[e - a] === u[n - a]; a++) ;
    return Lu = u.slice(l, 1 < a ? 1 - a : void 0);
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
  function $l(l) {
    function t(e, a, u, n, i) {
      this._reactName = e, this._targetInst = u, this.type = a, this.nativeEvent = n, this.target = i, this.currentTarget = null;
      for (var f in l)
        l.hasOwnProperty(f) && (e = l[f], this[f] = e ? e(n) : n[f]);
      return this.isDefaultPrevented = (n.defaultPrevented != null ? n.defaultPrevented : n.returnValue === !1) ? Vu : ls, this.isPropagationStopped = ls, this;
    }
    return j(t.prototype, {
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
  }, Ku = $l(De), Za = j({}, De, { view: 0, detail: 0 }), rm = $l(Za), ji, Ai, Va, Ju = j({}, Za, {
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
      return "movementX" in l ? l.movementX : (l !== Va && (Va && l.type === "mousemove" ? (ji = l.screenX - Va.screenX, Ai = l.screenY - Va.screenY) : Ai = ji = 0, Va = l), ji);
    },
    movementY: function(l) {
      return "movementY" in l ? l.movementY : Ai;
    }
  }), ts = $l(Ju), mm = j({}, Ju, { dataTransfer: 0 }), hm = $l(mm), vm = j({}, Za, { relatedTarget: 0 }), zi = $l(vm), ym = j({}, De, {
    animationName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), gm = $l(ym), Sm = j({}, De, {
    clipboardData: function(l) {
      return "clipboardData" in l ? l.clipboardData : window.clipboardData;
    }
  }), bm = $l(Sm), pm = j({}, De, { data: 0 }), es = $l(pm), jm = {
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
  }, Am = {
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
  }, zm = {
    Alt: "altKey",
    Control: "ctrlKey",
    Meta: "metaKey",
    Shift: "shiftKey"
  };
  function Tm(l) {
    var t = this.nativeEvent;
    return t.getModifierState ? t.getModifierState(l) : (l = zm[l]) ? !!t[l] : !1;
  }
  function Ti() {
    return Tm;
  }
  var Em = j({}, Za, {
    key: function(l) {
      if (l.key) {
        var t = jm[l.key] || l.key;
        if (t !== "Unidentified") return t;
      }
      return l.type === "keypress" ? (l = Zu(l), l === 13 ? "Enter" : String.fromCharCode(l)) : l.type === "keydown" || l.type === "keyup" ? Am[l.keyCode] || "Unidentified" : "";
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
  }), xm = $l(Em), Nm = j({}, Ju, {
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
  }), as = $l(Nm), _m = j({}, Za, {
    touches: 0,
    targetTouches: 0,
    changedTouches: 0,
    altKey: 0,
    metaKey: 0,
    ctrlKey: 0,
    shiftKey: 0,
    getModifierState: Ti
  }), Om = $l(_m), Mm = j({}, De, {
    propertyName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Dm = $l(Mm), Um = j({}, Ju, {
    deltaX: function(l) {
      return "deltaX" in l ? l.deltaX : "wheelDeltaX" in l ? -l.wheelDeltaX : 0;
    },
    deltaY: function(l) {
      return "deltaY" in l ? l.deltaY : "wheelDeltaY" in l ? -l.wheelDeltaY : "wheelDelta" in l ? -l.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), Rm = $l(Um), Cm = j({}, De, {
    newState: 0,
    oldState: 0
  }), Hm = $l(Cm), qm = [9, 13, 27, 32], Ei = Yt && "CompositionEvent" in window, Ka = null;
  Yt && "documentMode" in document && (Ka = document.documentMode);
  var Bm = Yt && "TextEvent" in window && !Ka, us = Yt && (!Ei || Ka && 8 < Ka && 11 >= Ka), ns = " ", is = !1;
  function cs(l, t) {
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
  function fs(l) {
    return l = l.detail, typeof l == "object" && "data" in l ? l.data : null;
  }
  var na = !1;
  function Ym(l, t) {
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
  function Gm(l, t) {
    if (na)
      return l === "compositionend" || !Ei && cs(l, t) ? (l = Pf(), Lu = pi = ae = null, na = !1, l) : null;
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
  var Qm = {
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
    return t === "input" ? !!Qm[l.type] : t === "textarea";
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
    wo(l, 0);
  }
  function wu(l) {
    var t = Qa(l);
    if (Kf(t)) return l;
  }
  function os(l, t) {
    if (l === "change") return t;
  }
  var rs = !1;
  if (Yt) {
    var xi;
    if (Yt) {
      var Ni = "oninput" in document;
      if (!Ni) {
        var ms = document.createElement("div");
        ms.setAttribute("oninput", "return;"), Ni = typeof ms.oninput == "function";
      }
      xi = Ni;
    } else xi = !1;
    rs = xi && (!document.documentMode || 9 < document.documentMode);
  }
  function hs() {
    Ja && (Ja.detachEvent("onpropertychange", vs), wa = Ja = null);
  }
  function vs(l) {
    if (l.propertyName === "value" && wu(wa)) {
      var t = [];
      ds(
        t,
        wa,
        l,
        gi(l)
      ), If(Xm, t);
    }
  }
  function Lm(l, t, e) {
    l === "focusin" ? (hs(), Ja = t, wa = e, Ja.attachEvent("onpropertychange", vs)) : l === "focusout" && hs();
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
  var at = typeof Object.is == "function" ? Object.is : Jm;
  function $a(l, t) {
    if (at(l, t)) return !0;
    if (typeof l != "object" || l === null || typeof t != "object" || t === null)
      return !1;
    var e = Object.keys(l), a = Object.keys(t);
    if (e.length !== a.length) return !1;
    for (a = 0; a < e.length; a++) {
      var u = e[a];
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
    var e = ys(l);
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
      e = ys(e);
    }
  }
  function Ss(l, t) {
    return l && t ? l === t ? !0 : l && l.nodeType === 3 ? !1 : t && t.nodeType === 3 ? Ss(l, t.parentNode) : "contains" in l ? l.contains(t) : l.compareDocumentPosition ? !!(l.compareDocumentPosition(t) & 16) : !1 : !1;
  }
  function bs(l) {
    l = l != null && l.ownerDocument != null && l.ownerDocument.defaultView != null ? l.ownerDocument.defaultView : window;
    for (var t = Qu(l.document); t instanceof l.HTMLIFrameElement; ) {
      try {
        var e = typeof t.contentWindow.location.href == "string";
      } catch {
        e = !1;
      }
      if (e) l = t.contentWindow;
      else break;
      t = Qu(l.document);
    }
    return t;
  }
  function _i(l) {
    var t = l && l.nodeName && l.nodeName.toLowerCase();
    return t && (t === "input" && (l.type === "text" || l.type === "search" || l.type === "tel" || l.type === "url" || l.type === "password") || t === "textarea" || l.contentEditable === "true");
  }
  var wm = Yt && "documentMode" in document && 11 >= document.documentMode, ia = null, Oi = null, Wa = null, Mi = !1;
  function ps(l, t, e) {
    var a = e.window === e ? e.document : e.nodeType === 9 ? e : e.ownerDocument;
    Mi || ia == null || ia !== Qu(a) || (a = ia, "selectionStart" in a && _i(a) ? a = { start: a.selectionStart, end: a.selectionEnd } : (a = (a.ownerDocument && a.ownerDocument.defaultView || window).getSelection(), a = {
      anchorNode: a.anchorNode,
      anchorOffset: a.anchorOffset,
      focusNode: a.focusNode,
      focusOffset: a.focusOffset
    }), Wa && $a(Wa, a) || (Wa = a, a = qn(Oi, "onSelect"), 0 < a.length && (t = new Ku(
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
  var As = Re("animationend"), zs = Re("animationiteration"), Ts = Re("animationstart"), $m = Re("transitionrun"), Wm = Re("transitionstart"), km = Re("transitioncancel"), Es = Re("transitionend"), xs = /* @__PURE__ */ new Map(), Ui = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
    " "
  );
  Ui.push("scrollEnd");
  function Tt(l, t) {
    xs.set(l, t), Me(t, [l]);
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
  }, vt = [], fa = 0, Ri = 0;
  function Wu() {
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
      n !== 0 && Ns(e, u, n);
    }
  }
  function ku(l, t, e, a) {
    vt[fa++] = l, vt[fa++] = t, vt[fa++] = e, vt[fa++] = a, Ri |= a, l.lanes |= a, l = l.alternate, l !== null && (l.lanes |= a);
  }
  function Ci(l, t, e, a) {
    return ku(l, t, e, a), Fu(l);
  }
  function Ce(l, t) {
    return ku(l, null, null, t), Fu(l);
  }
  function Ns(l, t, e) {
    l.lanes |= e;
    var a = l.alternate;
    a !== null && (a.lanes |= e);
    for (var u = !1, n = l.return; n !== null; )
      n.childLanes |= e, a = n.alternate, a !== null && (a.childLanes |= e), n.tag === 22 && (l = n.stateNode, l === null || l._visibility & 1 || (u = !0)), l = n, n = n.return;
    return l.tag === 3 ? (n = l.stateNode, u && t !== null && (u = 31 - et(e), l = n.hiddenUpdates, a = l[u], a === null ? l[u] = [t] : a.push(t), t.lane = e | 536870912), n) : null;
  }
  function Fu(l) {
    if (50 < gu)
      throw gu = 0, Zc = null, Error(o(185));
    for (var t = l.return; t !== null; )
      l = t, t = l.return;
    return l.tag === 3 ? l.stateNode : null;
  }
  var sa = {};
  function Fm(l, t, e, a) {
    this.tag = l, this.key = e, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = a, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function ut(l, t, e, a) {
    return new Fm(l, t, e, a);
  }
  function Hi(l) {
    return l = l.prototype, !(!l || !l.isReactComponent);
  }
  function Gt(l, t) {
    var e = l.alternate;
    return e === null ? (e = ut(
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
        case _t:
          return l = ut(31, e, t, u), l.elementType = _t, l.lanes = n, l;
        case k:
          return He(e.children, u, n, t);
        case xl:
          i = 8, u |= 24;
          break;
        case cl:
          return l = ut(12, e, t, u | 2), l.elementType = cl, l.lanes = n, l;
        case Nt:
          return l = ut(13, e, t, u), l.elementType = Nt, l.lanes = n, l;
        case Vl:
          return l = ut(19, e, t, u), l.elementType = Vl, l.lanes = n, l;
        default:
          if (typeof l == "object" && l !== null)
            switch (l.$$typeof) {
              case Gl:
                i = 10;
                break l;
              case P:
                i = 9;
                break l;
              case rt:
                i = 11;
                break l;
              case ll:
                i = 14;
                break l;
              case Kl:
                i = 16, a = null;
                break l;
            }
          i = 29, e = Error(
            o(130, l === null ? "null" : typeof l, "")
          ), a = null;
      }
    return t = ut(i, e, t, u), t.elementType = l, t.type = a, t.lanes = n, t;
  }
  function He(l, t, e, a) {
    return l = ut(7, l, a, t), l.lanes = e, l;
  }
  function qi(l, t, e) {
    return l = ut(6, l, null, t), l.lanes = e, l;
  }
  function Os(l) {
    var t = ut(18, null, null, 0);
    return t.stateNode = l, t;
  }
  function Bi(l, t, e) {
    return t = ut(
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
  function yt(l, t) {
    if (typeof l == "object" && l !== null) {
      var e = Ms.get(l);
      return e !== void 0 ? e : (t = {
        value: l,
        source: t,
        stack: Of(t)
      }, Ms.set(l, t), t);
    }
    return {
      value: l,
      source: t,
      stack: Of(t)
    };
  }
  var da = [], oa = 0, Pu = null, ka = 0, gt = [], St = 0, ue = null, Mt = 1, Dt = "";
  function Qt(l, t) {
    da[oa++] = ka, da[oa++] = Pu, Pu = l, ka = t;
  }
  function Ds(l, t, e) {
    gt[St++] = Mt, gt[St++] = Dt, gt[St++] = ue, ue = l;
    var a = Mt;
    l = Dt;
    var u = 32 - et(a) - 1;
    a &= ~(1 << u), e += 1;
    var n = 32 - et(t) + u;
    if (30 < n) {
      var i = u - u % 5;
      n = (a & (1 << i) - 1).toString(32), a >>= i, u -= i, Mt = 1 << 32 - et(t) + u | e << u | a, Dt = n + l;
    } else
      Mt = 1 << n | e << u | a, Dt = l;
  }
  function Yi(l) {
    l.return !== null && (Qt(l, 1), Ds(l, 1, 0));
  }
  function Gi(l) {
    for (; l === Pu; )
      Pu = da[--oa], da[oa] = null, ka = da[--oa], da[oa] = null;
    for (; l === ue; )
      ue = gt[--St], gt[St] = null, Dt = gt[--St], gt[St] = null, Mt = gt[--St], gt[St] = null;
  }
  function Us(l, t) {
    gt[St++] = Mt, gt[St++] = Dt, gt[St++] = ue, Mt = t.id, Dt = t.overflow, ue = l;
  }
  var Hl = null, yl = null, tl = !1, ne = null, bt = !1, Qi = Error(o(519));
  function ie(l) {
    var t = Error(
      o(
        418,
        1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML",
        ""
      )
    );
    throw Fa(yt(t, l)), Qi;
  }
  function Rs(l) {
    var t = l.stateNode, e = l.type, a = l.memoizedProps;
    switch (t[Cl] = l, t[wl] = a, e) {
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
        for (e = 0; e < bu.length; e++)
          W(bu[e], t);
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
        W("invalid", t);
        break;
      case "textarea":
        W("invalid", t), $f(t, a.value, a.defaultValue, a.children);
    }
    e = a.children, typeof e != "string" && typeof e != "number" && typeof e != "bigint" || t.textContent === "" + e || a.suppressHydrationWarning === !0 || Fo(t.textContent, e) ? (a.popover != null && (W("beforetoggle", t), W("toggle", t)), a.onScroll != null && W("scroll", t), a.onScrollEnd != null && W("scrollend", t), a.onClick != null && (t.onclick = Bt), t = !0) : t = !1, t || ie(l, !0);
  }
  function Cs(l) {
    for (Hl = l.return; Hl; )
      switch (Hl.tag) {
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
          Hl = Hl.return;
      }
  }
  function ra(l) {
    if (l !== Hl) return !1;
    if (!tl) return Cs(l), tl = !0, !1;
    var t = l.tag, e;
    if ((e = t !== 3 && t !== 27) && ((e = t === 5) && (e = l.type, e = !(e !== "form" && e !== "button") || uf(l.type, l.memoizedProps)), e = !e), e && yl && ie(l), Cs(l), t === 13) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(317));
      yl = ir(l);
    } else if (t === 31) {
      if (l = l.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(317));
      yl = ir(l);
    } else
      t === 27 ? (t = yl, pe(l.type) ? (l = df, df = null, yl = l) : yl = t) : yl = Hl ? jt(l.stateNode.nextSibling) : null;
    return !0;
  }
  function qe() {
    yl = Hl = null, tl = !1;
  }
  function Xi() {
    var l = ne;
    return l !== null && (Il === null ? Il = l : Il.push.apply(
      Il,
      l
    ), ne = null), l;
  }
  function Fa(l) {
    ne === null ? ne = [l] : ne.push(l);
  }
  var Li = r(null), Be = null, Xt = null;
  function ce(l, t, e) {
    U(Li, t._currentValue), t._currentValue = e;
  }
  function Lt(l) {
    l._currentValue = Li.current, E(Li);
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
          for (var s = 0; s < t.length; s++)
            if (f.context === t[s]) {
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
        if (i = u.return, i === null) throw Error(o(341));
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
        if (i === null) throw Error(o(387));
        if (i = i.memoizedProps, i !== null) {
          var f = u.type;
          at(u.pendingProps.value, i.value) || (l !== null ? l.push(f) : l = [f]);
        }
      } else if (u === il.current) {
        if (i = u.alternate, i === null) throw Error(o(387));
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
      if (!at(
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
  function ql(l) {
    return Hs(Be, l);
  }
  function tn(l, t) {
    return Be === null && Ye(l), Hs(l, t);
  }
  function Hs(l, t) {
    var e = t._currentValue;
    if (t = { context: t, memoizedValue: e, next: null }, Xt === null) {
      if (l === null) throw Error(o(308));
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
  }, Pm = m.unstable_scheduleCallback, lh = m.unstable_NormalPriority, Nl = {
    $$typeof: Gl,
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
    return Ji++, t.then(qs, qs), t;
  }
  function qs() {
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
  var Bs = A.S;
  A.S = function(l, t) {
    jo = lt(), typeof t == "object" && t !== null && typeof t.then == "function" && th(l, t), Bs !== null && Bs(l, t);
  };
  var Ge = r(null);
  function wi() {
    var l = Ge.current;
    return l !== null ? l : vl.pooledCache;
  }
  function en(l, t) {
    t === null ? U(Ge, Ge.current) : U(Ge, t.pool);
  }
  function Ys() {
    var l = wi();
    return l === null ? null : { parent: Nl._currentValue, pool: l };
  }
  var ya = Error(o(460)), $i = Error(o(474)), an = Error(o(542)), un = { then: function() {
  } };
  function Gs(l) {
    return l = l.status, l === "fulfilled" || l === "rejected";
  }
  function Qs(l, t, e) {
    switch (e = l[e], e === void 0 ? l.push(t) : e !== t && (t.then(Bt, Bt), t = e), t.status) {
      case "fulfilled":
        return t.value;
      case "rejected":
        throw l = t.reason, Ls(l), l;
      default:
        if (typeof t.status == "string") t.then(Bt, Bt);
        else {
          if (l = vl, l !== null && 100 < l.shellSuspendCounter)
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
            throw l = t.reason, Ls(l), l;
        }
        throw Xe = t, ya;
    }
  }
  function Qe(l) {
    try {
      var t = l._init;
      return t(l._payload);
    } catch (e) {
      throw e !== null && typeof e == "object" && typeof e.then == "function" ? (Xe = e, ya) : e;
    }
  }
  var Xe = null;
  function Xs() {
    if (Xe === null) throw Error(o(459));
    var l = Xe;
    return Xe = null, l;
  }
  function Ls(l) {
    if (l === ya || l === an)
      throw Error(o(483));
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
    throw t.$$typeof === O ? Error(o(525)) : (l = Object.prototype.toString.call(t), Error(
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
      return d === null || d.tag !== 6 ? (d = qi(v, h.mode, z), d.return = h, d) : (d = u(d, v), d.return = h, d);
    }
    function s(h, d, v, z) {
      var Y = v.type;
      return Y === k ? p(
        h,
        d,
        v.props.children,
        z,
        v.key
      ) : d !== null && (d.elementType === Y || typeof Y == "object" && Y !== null && Y.$$typeof === Kl && Qe(Y) === d.type) ? (d = u(d, v.props), tu(d, v), d.return = h, d) : (d = Iu(
        v.type,
        v.key,
        v.props,
        null,
        h.mode,
        z
      ), tu(d, v), d.return = h, d);
    }
    function y(h, d, v, z) {
      return d === null || d.tag !== 4 || d.stateNode.containerInfo !== v.containerInfo || d.stateNode.implementation !== v.implementation ? (d = Bi(v, h.mode, z), d.return = h, d) : (d = u(d, v.children || []), d.return = h, d);
    }
    function p(h, d, v, z, Y) {
      return d === null || d.tag !== 7 ? (d = He(
        v,
        h.mode,
        z,
        Y
      ), d.return = h, d) : (d = u(d, v), d.return = h, d);
    }
    function T(h, d, v) {
      if (typeof d == "string" && d !== "" || typeof d == "number" || typeof d == "bigint")
        return d = qi(
          "" + d,
          h.mode,
          v
        ), d.return = h, d;
      if (typeof d == "object" && d !== null) {
        switch (d.$$typeof) {
          case ul:
            return v = Iu(
              d.type,
              d.key,
              d.props,
              null,
              h.mode,
              v
            ), tu(v, d), v.return = h, v;
          case El:
            return d = Bi(
              d,
              h.mode,
              v
            ), d.return = h, d;
          case Kl:
            return d = Qe(d), T(h, d, v);
        }
        if (zt(d) || Jl(d))
          return d = He(
            d,
            h.mode,
            v,
            null
          ), d.return = h, d;
        if (typeof d.then == "function")
          return T(h, nn(d), v);
        if (d.$$typeof === Gl)
          return T(
            h,
            tn(h, d),
            v
          );
        cn(h, d);
      }
      return null;
    }
    function g(h, d, v, z) {
      var Y = d !== null ? d.key : null;
      if (typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint")
        return Y !== null ? null : f(h, d, "" + v, z);
      if (typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case ul:
            return v.key === Y ? s(h, d, v, z) : null;
          case El:
            return v.key === Y ? y(h, d, v, z) : null;
          case Kl:
            return v = Qe(v), g(h, d, v, z);
        }
        if (zt(v) || Jl(v))
          return Y !== null ? null : p(h, d, v, z, null);
        if (typeof v.then == "function")
          return g(
            h,
            d,
            nn(v),
            z
          );
        if (v.$$typeof === Gl)
          return g(
            h,
            d,
            tn(h, v),
            z
          );
        cn(h, v);
      }
      return null;
    }
    function S(h, d, v, z, Y) {
      if (typeof z == "string" && z !== "" || typeof z == "number" || typeof z == "bigint")
        return h = h.get(v) || null, f(d, h, "" + z, Y);
      if (typeof z == "object" && z !== null) {
        switch (z.$$typeof) {
          case ul:
            return h = h.get(
              z.key === null ? v : z.key
            ) || null, s(d, h, z, Y);
          case El:
            return h = h.get(
              z.key === null ? v : z.key
            ) || null, y(d, h, z, Y);
          case Kl:
            return z = Qe(z), S(
              h,
              d,
              v,
              z,
              Y
            );
        }
        if (zt(z) || Jl(z))
          return h = h.get(v) || null, p(d, h, z, Y, null);
        if (typeof z.then == "function")
          return S(
            h,
            d,
            v,
            nn(z),
            Y
          );
        if (z.$$typeof === Gl)
          return S(
            h,
            d,
            v,
            tn(d, z),
            Y
          );
        cn(d, z);
      }
      return null;
    }
    function C(h, d, v, z) {
      for (var Y = null, el = null, B = d, J = d = 0, I = null; B !== null && J < v.length; J++) {
        B.index > J ? (I = B, B = null) : I = B.sibling;
        var al = g(
          h,
          B,
          v[J],
          z
        );
        if (al === null) {
          B === null && (B = I);
          break;
        }
        l && B && al.alternate === null && t(h, B), d = n(al, d, J), el === null ? Y = al : el.sibling = al, el = al, B = I;
      }
      if (J === v.length)
        return e(h, B), tl && Qt(h, J), Y;
      if (B === null) {
        for (; J < v.length; J++)
          B = T(h, v[J], z), B !== null && (d = n(
            B,
            d,
            J
          ), el === null ? Y = B : el.sibling = B, el = B);
        return tl && Qt(h, J), Y;
      }
      for (B = a(B); J < v.length; J++)
        I = S(
          B,
          h,
          J,
          v[J],
          z
        ), I !== null && (l && I.alternate !== null && B.delete(
          I.key === null ? J : I.key
        ), d = n(
          I,
          d,
          J
        ), el === null ? Y = I : el.sibling = I, el = I);
      return l && B.forEach(function(Ee) {
        return t(h, Ee);
      }), tl && Qt(h, J), Y;
    }
    function G(h, d, v, z) {
      if (v == null) throw Error(o(151));
      for (var Y = null, el = null, B = d, J = d = 0, I = null, al = v.next(); B !== null && !al.done; J++, al = v.next()) {
        B.index > J ? (I = B, B = null) : I = B.sibling;
        var Ee = g(h, B, al.value, z);
        if (Ee === null) {
          B === null && (B = I);
          break;
        }
        l && B && Ee.alternate === null && t(h, B), d = n(Ee, d, J), el === null ? Y = Ee : el.sibling = Ee, el = Ee, B = I;
      }
      if (al.done)
        return e(h, B), tl && Qt(h, J), Y;
      if (B === null) {
        for (; !al.done; J++, al = v.next())
          al = T(h, al.value, z), al !== null && (d = n(al, d, J), el === null ? Y = al : el.sibling = al, el = al);
        return tl && Qt(h, J), Y;
      }
      for (B = a(B); !al.done; J++, al = v.next())
        al = S(B, h, J, al.value, z), al !== null && (l && al.alternate !== null && B.delete(al.key === null ? J : al.key), d = n(al, d, J), el === null ? Y = al : el.sibling = al, el = al);
      return l && B.forEach(function(mv) {
        return t(h, mv);
      }), tl && Qt(h, J), Y;
    }
    function ml(h, d, v, z) {
      if (typeof v == "object" && v !== null && v.type === k && v.key === null && (v = v.props.children), typeof v == "object" && v !== null) {
        switch (v.$$typeof) {
          case ul:
            l: {
              for (var Y = v.key; d !== null; ) {
                if (d.key === Y) {
                  if (Y = v.type, Y === k) {
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
                  } else if (d.elementType === Y || typeof Y == "object" && Y !== null && Y.$$typeof === Kl && Qe(Y) === d.type) {
                    e(
                      h,
                      d.sibling
                    ), z = u(d, v.props), tu(z, v), z.return = h, h = z;
                    break l;
                  }
                  e(h, d);
                  break;
                } else t(h, d);
                d = d.sibling;
              }
              v.type === k ? (z = He(
                v.props.children,
                h.mode,
                z,
                v.key
              ), z.return = h, h = z) : (z = Iu(
                v.type,
                v.key,
                v.props,
                null,
                h.mode,
                z
              ), tu(z, v), z.return = h, h = z);
            }
            return i(h);
          case El:
            l: {
              for (Y = v.key; d !== null; ) {
                if (d.key === Y)
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
              z = Bi(v, h.mode, z), z.return = h, h = z;
            }
            return i(h);
          case Kl:
            return v = Qe(v), ml(
              h,
              d,
              v,
              z
            );
        }
        if (zt(v))
          return C(
            h,
            d,
            v,
            z
          );
        if (Jl(v)) {
          if (Y = Jl(v), typeof Y != "function") throw Error(o(150));
          return v = Y.call(v), G(
            h,
            d,
            v,
            z
          );
        }
        if (typeof v.then == "function")
          return ml(
            h,
            d,
            nn(v),
            z
          );
        if (v.$$typeof === Gl)
          return ml(
            h,
            d,
            tn(h, v),
            z
          );
        cn(h, v);
      }
      return typeof v == "string" && v !== "" || typeof v == "number" || typeof v == "bigint" ? (v = "" + v, d !== null && d.tag === 6 ? (e(h, d.sibling), z = u(d, v), z.return = h, h = z) : (e(h, d), z = qi(v, h.mode, z), z.return = h, h = z), i(h)) : e(h, d);
    }
    return function(h, d, v, z) {
      try {
        lu = 0;
        var Y = ml(
          h,
          d,
          v,
          z
        );
        return ga = null, Y;
      } catch (B) {
        if (B === ya || B === an) throw B;
        var el = ut(29, B, null, h.mode);
        return el.lanes = z, el.return = h, el;
      }
    };
  }
  var Le = Zs(!0), Vs = Zs(!1), fe = !1;
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
  function de(l, t, e) {
    var a = l.updateQueue;
    if (a === null) return null;
    if (a = a.shared, (nl & 2) !== 0) {
      var u = a.pending;
      return u === null ? t.next = t : (t.next = u.next, u.next = t), a.pending = t, t = Fu(l), Ns(l, null, e), t;
    }
    return ku(l, a, t, e), Fu(l);
  }
  function eu(l, t, e) {
    if (t = t.updateQueue, t !== null && (t = t.shared, (e & 4194048) !== 0)) {
      var a = t.lanes;
      a &= l.pendingLanes, e |= a, t.lanes = e, Hf(l, e);
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
      var s = f, y = s.next;
      s.next = null, i === null ? n = y : i.next = y, i = s;
      var p = l.alternate;
      p !== null && (p = p.updateQueue, f = p.lastBaseUpdate, f !== i && (f === null ? p.firstBaseUpdate = y : f.next = y, p.lastBaseUpdate = s));
    }
    if (n !== null) {
      var T = u.baseState;
      i = 0, p = y = s = null, f = n;
      do {
        var g = f.lane & -536870913, S = g !== f.lane;
        if (S ? (F & g) === g : (a & g) === g) {
          g !== 0 && g === ha && (Ii = !0), p !== null && (p = p.next = {
            lane: 0,
            tag: f.tag,
            payload: f.payload,
            callback: null,
            next: null
          });
          l: {
            var C = l, G = f;
            g = t;
            var ml = e;
            switch (G.tag) {
              case 1:
                if (C = G.payload, typeof C == "function") {
                  T = C.call(ml, T, g);
                  break l;
                }
                T = C;
                break l;
              case 3:
                C.flags = C.flags & -65537 | 128;
              case 0:
                if (C = G.payload, g = typeof C == "function" ? C.call(ml, T, g) : C, g == null) break l;
                T = j({}, T, g);
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
          }, p === null ? (y = p = S, s = T) : p = p.next = S, i |= g;
        if (f = f.next, f === null) {
          if (f = u.shared.pending, f === null)
            break;
          S = f, f = S.next, S.next = null, u.lastBaseUpdate = S, u.shared.pending = null;
        }
      } while (!0);
      p === null && (s = T), u.baseState = s, u.firstBaseUpdate = y, u.lastBaseUpdate = p, n === null && (u.shared.lanes = 0), ve |= i, l.lanes = i, l.memoizedState = T;
    }
  }
  function Ks(l, t) {
    if (typeof l != "function")
      throw Error(o(191, l));
    l.call(t);
  }
  function Js(l, t) {
    var e = l.callbacks;
    if (e !== null)
      for (l.callbacks = null, l = 0; l < e.length; l++)
        Ks(e[l], t);
  }
  var Sa = r(null), fn = r(0);
  function ws(l, t) {
    l = Ft, U(fn, l), U(Sa, t), Ft = l | t.baseLanes;
  }
  function Pi() {
    U(fn, Ft), U(Sa, Sa.current);
  }
  function lc() {
    Ft = fn.current, E(Sa), E(fn);
  }
  var nt = r(null), pt = null;
  function oe(l) {
    var t = l.alternate;
    U(zl, zl.current & 1), U(nt, l), pt === null && (t === null || Sa.current !== null || t.memoizedState !== null) && (pt = l);
  }
  function tc(l) {
    U(zl, zl.current), U(nt, l), pt === null && (pt = l);
  }
  function $s(l) {
    l.tag === 22 ? (U(zl, zl.current), U(nt, l), pt === null && (pt = l)) : re();
  }
  function re() {
    U(zl, zl.current), U(nt, nt.current);
  }
  function it(l) {
    E(nt), pt === l && (pt = null), E(zl);
  }
  var zl = r(0);
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
  var Zt = 0, K = null, ol = null, _l = null, dn = !1, ba = !1, Ze = !1, on = 0, nu = 0, pa = null, ah = 0;
  function pl() {
    throw Error(o(321));
  }
  function ec(l, t) {
    if (t === null) return !1;
    for (var e = 0; e < t.length && e < l.length; e++)
      if (!at(l[e], t[e])) return !1;
    return !0;
  }
  function ac(l, t, e, a, u, n) {
    return Zt = n, K = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, A.H = l === null || l.memoizedState === null ? Dd : Sc, Ze = !1, n = e(a, u), Ze = !1, ba && (n = ks(
      t,
      e,
      a,
      u
    )), Ws(l), n;
  }
  function Ws(l) {
    A.H = fu;
    var t = ol !== null && ol.next !== null;
    if (Zt = 0, _l = ol = K = null, dn = !1, nu = 0, pa = null, t) throw Error(o(300));
    l === null || Ol || (l = l.dependencies, l !== null && ln(l) && (Ol = !0));
  }
  function ks(l, t, e, a) {
    K = l;
    var u = 0;
    do {
      if (ba && (pa = null), nu = 0, ba = !1, 25 <= u) throw Error(o(301));
      if (u += 1, _l = ol = null, l.updateQueue != null) {
        var n = l.updateQueue;
        n.lastEffect = null, n.events = null, n.stores = null, n.memoCache != null && (n.memoCache.index = 0);
      }
      A.H = Ud, n = t(e, a);
    } while (ba);
    return n;
  }
  function uh() {
    var l = A.H, t = l.useState()[0];
    return t = typeof t.then == "function" ? iu(t) : t, l = l.useState()[0], (ol !== null ? ol.memoizedState : null) !== l && (K.flags |= 1024), t;
  }
  function uc() {
    var l = on !== 0;
    return on = 0, l;
  }
  function nc(l, t, e) {
    t.updateQueue = l.updateQueue, t.flags &= -2053, l.lanes &= ~e;
  }
  function ic(l) {
    if (dn) {
      for (l = l.memoizedState; l !== null; ) {
        var t = l.queue;
        t !== null && (t.pending = null), l = l.next;
      }
      dn = !1;
    }
    Zt = 0, _l = ol = K = null, ba = !1, nu = on = 0, pa = null;
  }
  function Zl() {
    var l = {
      memoizedState: null,
      baseState: null,
      baseQueue: null,
      queue: null,
      next: null
    };
    return _l === null ? K.memoizedState = _l = l : _l = _l.next = l, _l;
  }
  function Tl() {
    if (ol === null) {
      var l = K.alternate;
      l = l !== null ? l.memoizedState : null;
    } else l = ol.next;
    var t = _l === null ? K.memoizedState : _l.next;
    if (t !== null)
      _l = t, ol = l;
    else {
      if (l === null)
        throw K.alternate === null ? Error(o(467)) : Error(o(310));
      ol = l, l = {
        memoizedState: ol.memoizedState,
        baseState: ol.baseState,
        baseQueue: ol.baseQueue,
        queue: ol.queue,
        next: null
      }, _l === null ? K.memoizedState = _l = l : _l = _l.next = l;
    }
    return _l;
  }
  function rn() {
    return { lastEffect: null, events: null, stores: null, memoCache: null };
  }
  function iu(l) {
    var t = nu;
    return nu += 1, pa === null && (pa = []), l = Qs(pa, l, t), t = K, (_l === null ? t.memoizedState : _l.next) === null && (t = t.alternate, A.H = t === null || t.memoizedState === null ? Dd : Sc), l;
  }
  function mn(l) {
    if (l !== null && typeof l == "object") {
      if (typeof l.then == "function") return iu(l);
      if (l.$$typeof === Gl) return ql(l);
    }
    throw Error(o(438, String(l)));
  }
  function cc(l) {
    var t = null, e = K.updateQueue;
    if (e !== null && (t = e.memoCache), t == null) {
      var a = K.alternate;
      a !== null && (a = a.updateQueue, a !== null && (a = a.memoCache, a != null && (t = {
        data: a.data.map(function(u) {
          return u.slice();
        }),
        index: 0
      })));
    }
    if (t == null && (t = { data: [], index: 0 }), e === null && (e = rn(), K.updateQueue = e), e.memoCache = t, e = t.data[t.index], e === void 0)
      for (e = t.data[t.index] = Array(l), a = 0; a < l; a++)
        e[a] = We;
    return t.index++, e;
  }
  function Vt(l, t) {
    return typeof t == "function" ? t(l) : t;
  }
  function hn(l) {
    var t = Tl();
    return fc(t, ol, l);
  }
  function fc(l, t, e) {
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
      var f = i = null, s = null, y = t, p = !1;
      do {
        var T = y.lane & -536870913;
        if (T !== y.lane ? (F & T) === T : (Zt & T) === T) {
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
            }), T === ha && (p = !0);
          else if ((Zt & g) === g) {
            y = y.next, g === ha && (p = !0);
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
            }, s === null ? (f = s = T, i = n) : s = s.next = T, K.lanes |= g, ve |= g;
          T = y.action, Ze && e(n, T), n = y.hasEagerState ? y.eagerState : e(n, T);
        } else
          g = {
            lane: T,
            revertLane: y.revertLane,
            gesture: y.gesture,
            action: y.action,
            hasEagerState: y.hasEagerState,
            eagerState: y.eagerState,
            next: null
          }, s === null ? (f = s = g, i = n) : s = s.next = g, K.lanes |= T, ve |= T;
        y = y.next;
      } while (y !== null && y !== t);
      if (s === null ? i = n : s.next = f, !at(n, l.memoizedState) && (Ol = !0, p && (e = va, e !== null)))
        throw e;
      l.memoizedState = n, l.baseState = i, l.baseQueue = s, a.lastRenderedState = n;
    }
    return u === null && (a.lanes = 0), [l.memoizedState, a.dispatch];
  }
  function sc(l) {
    var t = Tl(), e = t.queue;
    if (e === null) throw Error(o(311));
    e.lastRenderedReducer = l;
    var a = e.dispatch, u = e.pending, n = t.memoizedState;
    if (u !== null) {
      e.pending = null;
      var i = u = u.next;
      do
        n = l(n, i.action), i = i.next;
      while (i !== u);
      at(n, t.memoizedState) || (Ol = !0), t.memoizedState = n, t.baseQueue === null && (t.baseState = n), e.lastRenderedState = n;
    }
    return [n, a];
  }
  function Fs(l, t, e) {
    var a = K, u = Tl(), n = tl;
    if (n) {
      if (e === void 0) throw Error(o(407));
      e = e();
    } else e = t();
    var i = !at(
      (ol || u).memoizedState,
      e
    );
    if (i && (u.memoizedState = e, Ol = !0), u = u.queue, rc(ld.bind(null, a, u, l), [
      l
    ]), u.getSnapshot !== t || i || _l !== null && _l.memoizedState.tag & 1) {
      if (a.flags |= 2048, ja(
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
      ), vl === null) throw Error(o(349));
      n || (Zt & 127) !== 0 || Is(a, t, e);
    }
    return e;
  }
  function Is(l, t, e) {
    l.flags |= 16384, l = { getSnapshot: t, value: e }, t = K.updateQueue, t === null ? (t = rn(), K.updateQueue = t, t.stores = [l]) : (e = t.stores, e === null ? t.stores = [l] : e.push(l));
  }
  function Ps(l, t, e, a) {
    t.value = e, t.getSnapshot = a, td(t) && ed(l);
  }
  function ld(l, t, e) {
    return e(function() {
      td(t) && ed(l);
    });
  }
  function td(l) {
    var t = l.getSnapshot;
    l = l.value;
    try {
      var e = t();
      return !at(l, e);
    } catch {
      return !0;
    }
  }
  function ed(l) {
    var t = Ce(l, 2);
    t !== null && Pl(t, l, 2);
  }
  function dc(l) {
    var t = Zl();
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
  function ad(l, t, e, a) {
    return l.baseState = e, fc(
      l,
      ol,
      typeof a == "function" ? a : Vt
    );
  }
  function nh(l, t, e, a, u) {
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
      A.T !== null ? e(!0) : n.isTransition = !1, a(n), e = t.pending, e === null ? (n.next = t.pending = n, ud(t, n)) : (n.next = e.next, t.pending = e.next = n);
    }
  }
  function ud(l, t) {
    var e = t.action, a = t.payload, u = l.state;
    if (t.isTransition) {
      var n = A.T, i = {};
      A.T = i;
      try {
        var f = e(u, a), s = A.S;
        s !== null && s(i, f), nd(l, t, f);
      } catch (y) {
        oc(l, t, y);
      } finally {
        n !== null && i.types !== null && (n.types = i.types), A.T = n;
      }
    } else
      try {
        n = e(u, a), nd(l, t, n);
      } catch (y) {
        oc(l, t, y);
      }
  }
  function nd(l, t, e) {
    e !== null && typeof e == "object" && typeof e.then == "function" ? e.then(
      function(a) {
        id(l, t, a);
      },
      function(a) {
        return oc(l, t, a);
      }
    ) : id(l, t, e);
  }
  function id(l, t, e) {
    t.status = "fulfilled", t.value = e, cd(t), l.state = e, t = l.pending, t !== null && (e = t.next, e === t ? l.pending = null : (e = e.next, t.next = e, ud(l, e)));
  }
  function oc(l, t, e) {
    var a = l.pending;
    if (l.pending = null, a !== null) {
      a = a.next;
      do
        t.status = "rejected", t.reason = e, cd(t), t = t.next;
      while (t !== a);
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
    if (tl) {
      var e = vl.formState;
      if (e !== null) {
        l: {
          var a = K;
          if (tl) {
            if (yl) {
              t: {
                for (var u = yl, n = bt; u.nodeType !== 8; ) {
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
                yl = jt(
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
    return e = Zl(), e.memoizedState = e.baseState = t, a = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: fd,
      lastRenderedState: t
    }, e.queue = a, e = _d.bind(
      null,
      K,
      a
    ), a.dispatch = e, a = dc(!1), n = gc.bind(
      null,
      K,
      !1,
      a.queue
    ), a = Zl(), u = {
      state: t,
      dispatch: null,
      action: l,
      pending: null
    }, a.queue = u, e = nh.bind(
      null,
      K,
      u,
      n,
      e
    ), u.dispatch = e, a.memoizedState = l, [t, e, !1];
  }
  function dd(l) {
    var t = Tl();
    return od(t, ol, l);
  }
  function od(l, t, e) {
    if (t = fc(
      l,
      t,
      fd
    )[0], l = hn(Vt)[0], typeof t == "object" && t !== null && typeof t.then == "function")
      try {
        var a = iu(t);
      } catch (i) {
        throw i === ya ? an : i;
      }
    else a = t;
    t = Tl();
    var u = t.queue, n = u.dispatch;
    return e !== t.memoizedState && (K.flags |= 2048, ja(
      9,
      { destroy: void 0 },
      ih.bind(null, u, e),
      null
    )), [a, n, l];
  }
  function ih(l, t) {
    l.action = t;
  }
  function rd(l) {
    var t = Tl(), e = ol;
    if (e !== null)
      return od(t, e, l);
    Tl(), t = t.memoizedState, e = Tl();
    var a = e.queue.dispatch;
    return e.memoizedState = l, [t, a, !1];
  }
  function ja(l, t, e, a) {
    return l = { tag: l, create: e, deps: a, inst: t, next: null }, t = K.updateQueue, t === null && (t = rn(), K.updateQueue = t), e = t.lastEffect, e === null ? t.lastEffect = l.next = l : (a = e.next, e.next = l, l.next = a, t.lastEffect = l), l;
  }
  function md() {
    return Tl().memoizedState;
  }
  function vn(l, t, e, a) {
    var u = Zl();
    K.flags |= l, u.memoizedState = ja(
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
    ol !== null && a !== null && ec(a, ol.memoizedState.deps) ? u.memoizedState = ja(t, n, e, a) : (K.flags |= l, u.memoizedState = ja(
      1 | t,
      n,
      e,
      a
    ));
  }
  function hd(l, t) {
    vn(8390656, 8, l, t);
  }
  function rc(l, t) {
    yn(2048, 8, l, t);
  }
  function ch(l) {
    K.flags |= 4;
    var t = K.updateQueue;
    if (t === null)
      t = rn(), K.updateQueue = t, t.events = [l];
    else {
      var e = t.events;
      e === null ? t.events = [l] : e.push(l);
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
  function bd(l, t, e) {
    e = e != null ? e.concat([l]) : null, yn(4, 4, Sd.bind(null, t, l), e);
  }
  function mc() {
  }
  function pd(l, t) {
    var e = Tl();
    t = t === void 0 ? null : t;
    var a = e.memoizedState;
    return t !== null && ec(t, a[1]) ? a[0] : (e.memoizedState = [l, t], l);
  }
  function jd(l, t) {
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
    return e === void 0 || (Zt & 1073741824) !== 0 && (F & 261930) === 0 ? l.memoizedState = t : (l.memoizedState = e, l = zo(), K.lanes |= l, ve |= l, e);
  }
  function Ad(l, t, e, a) {
    return at(e, t) ? e : Sa.current !== null ? (l = hc(l, e, a), at(l, t) || (Ol = !0), l) : (Zt & 42) === 0 || (Zt & 1073741824) !== 0 && (F & 261930) === 0 ? (Ol = !0, l.memoizedState = e) : (l = zo(), K.lanes |= l, ve |= l, t);
  }
  function zd(l, t, e, a, u) {
    var n = D.p;
    D.p = n !== 0 && 8 > n ? n : 8;
    var i = A.T, f = {};
    A.T = f, gc(l, !1, t, e);
    try {
      var s = u(), y = A.S;
      if (y !== null && y(f, s), s !== null && typeof s == "object" && typeof s.then == "function") {
        var p = eh(
          s,
          a
        );
        cu(
          l,
          t,
          p,
          st(l)
        );
      } else
        cu(
          l,
          t,
          a,
          st(l)
        );
    } catch (T) {
      cu(
        l,
        t,
        { then: function() {
        }, status: "rejected", reason: T },
        st()
      );
    } finally {
      D.p = n, i !== null && f.types !== null && (i.types = f.types), A.T = i;
    }
  }
  function fh() {
  }
  function vc(l, t, e, a) {
    if (l.tag !== 5) throw Error(o(476));
    var u = Td(l).queue;
    zd(
      l,
      u,
      t,
      Q,
      e === null ? fh : function() {
        return Ed(l), e(a);
      }
    );
  }
  function Td(l) {
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
        lastRenderedReducer: Vt,
        lastRenderedState: Q
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
  function Ed(l) {
    var t = Td(l);
    t.next === null && (t = l.alternate.memoizedState), cu(
      l,
      t.next.queue,
      {},
      st()
    );
  }
  function yc() {
    return ql(Tu);
  }
  function xd() {
    return Tl().memoizedState;
  }
  function Nd() {
    return Tl().memoizedState;
  }
  function sh(l) {
    for (var t = l.return; t !== null; ) {
      switch (t.tag) {
        case 24:
        case 3:
          var e = st();
          l = se(e);
          var a = de(t, l, e);
          a !== null && (Pl(a, t, e), eu(a, t, e)), t = { cache: Ki() }, l.payload = t;
          return;
      }
      t = t.return;
    }
  }
  function dh(l, t, e) {
    var a = st();
    e = {
      lane: a,
      revertLane: 0,
      gesture: null,
      action: e,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, gn(l) ? Od(t, e) : (e = Ci(l, t, e, a), e !== null && (Pl(e, l, a), Md(e, t, a)));
  }
  function _d(l, t, e) {
    var a = st();
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
    if (gn(l)) Od(t, u);
    else {
      var n = l.alternate;
      if (l.lanes === 0 && (n === null || n.lanes === 0) && (n = t.lastRenderedReducer, n !== null))
        try {
          var i = t.lastRenderedState, f = n(i, e);
          if (u.hasEagerState = !0, u.eagerState = f, at(f, i))
            return ku(l, t, u, 0), vl === null && Wu(), !1;
        } catch {
        }
      if (e = Ci(l, t, u, a), e !== null)
        return Pl(e, l, a), Md(e, t, a), !0;
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
      if (t) throw Error(o(479));
    } else
      t = Ci(
        l,
        e,
        a,
        2
      ), t !== null && Pl(t, l, 2);
  }
  function gn(l) {
    var t = l.alternate;
    return l === K || t !== null && t === K;
  }
  function Od(l, t) {
    ba = dn = !0;
    var e = l.pending;
    e === null ? t.next = t : (t.next = e.next, e.next = t), l.pending = t;
  }
  function Md(l, t, e) {
    if ((e & 4194048) !== 0) {
      var a = t.lanes;
      a &= l.pendingLanes, e |= a, t.lanes = e, Hf(l, e);
    }
  }
  var fu = {
    readContext: ql,
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
  var Dd = {
    readContext: ql,
    use: mn,
    useCallback: function(l, t) {
      return Zl().memoizedState = [
        l,
        t === void 0 ? null : t
      ], l;
    },
    useContext: ql,
    useEffect: hd,
    useImperativeHandle: function(l, t, e) {
      e = e != null ? e.concat([l]) : null, vn(
        4194308,
        4,
        Sd.bind(null, t, l),
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
      var e = Zl();
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
      var a = Zl();
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
      }, a.queue = l, l = l.dispatch = dh.bind(
        null,
        K,
        l
      ), [a.memoizedState, l];
    },
    useRef: function(l) {
      var t = Zl();
      return l = { current: l }, t.memoizedState = l;
    },
    useState: function(l) {
      l = dc(l);
      var t = l.queue, e = _d.bind(null, K, t);
      return t.dispatch = e, [l.memoizedState, e];
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = Zl();
      return hc(e, l, t);
    },
    useTransition: function() {
      var l = dc(!1);
      return l = zd.bind(
        null,
        K,
        l.queue,
        !0,
        !1
      ), Zl().memoizedState = l, [!1, l];
    },
    useSyncExternalStore: function(l, t, e) {
      var a = K, u = Zl();
      if (tl) {
        if (e === void 0)
          throw Error(o(407));
        e = e();
      } else {
        if (e = t(), vl === null)
          throw Error(o(349));
        (F & 127) !== 0 || Is(a, t, e);
      }
      u.memoizedState = e;
      var n = { value: e, getSnapshot: t };
      return u.queue = n, hd(ld.bind(null, a, n, l), [
        l
      ]), a.flags |= 2048, ja(
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
      var l = Zl(), t = vl.identifierPrefix;
      if (tl) {
        var e = Dt, a = Mt;
        e = (a & ~(1 << 32 - et(a) - 1)).toString(32) + e, t = "_" + t + "R_" + e, e = on++, 0 < e && (t += "H" + e.toString(32)), t += "_";
      } else
        e = ah++, t = "_" + t + "r_" + e.toString(32) + "_";
      return l.memoizedState = t;
    },
    useHostTransitionStatus: yc,
    useFormState: sd,
    useActionState: sd,
    useOptimistic: function(l) {
      var t = Zl();
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
        K,
        !0,
        e
      ), e.dispatch = t, [l, t];
    },
    useMemoCache: cc,
    useCacheRefresh: function() {
      return Zl().memoizedState = sh.bind(
        null,
        K
      );
    },
    useEffectEvent: function(l) {
      var t = Zl(), e = { impl: l };
      return t.memoizedState = e, function() {
        if ((nl & 2) !== 0)
          throw Error(o(440));
        return e.impl.apply(void 0, arguments);
      };
    }
  }, Sc = {
    readContext: ql,
    use: mn,
    useCallback: pd,
    useContext: ql,
    useEffect: rc,
    useImperativeHandle: bd,
    useInsertionEffect: yd,
    useLayoutEffect: gd,
    useMemo: jd,
    useReducer: hn,
    useRef: md,
    useState: function() {
      return hn(Vt);
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = Tl();
      return Ad(
        e,
        ol.memoizedState,
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
    useSyncExternalStore: Fs,
    useId: xd,
    useHostTransitionStatus: yc,
    useFormState: dd,
    useActionState: dd,
    useOptimistic: function(l, t) {
      var e = Tl();
      return ad(e, ol, l, t);
    },
    useMemoCache: cc,
    useCacheRefresh: Nd
  };
  Sc.useEffectEvent = vd;
  var Ud = {
    readContext: ql,
    use: mn,
    useCallback: pd,
    useContext: ql,
    useEffect: rc,
    useImperativeHandle: bd,
    useInsertionEffect: yd,
    useLayoutEffect: gd,
    useMemo: jd,
    useReducer: sc,
    useRef: md,
    useState: function() {
      return sc(Vt);
    },
    useDebugValue: mc,
    useDeferredValue: function(l, t) {
      var e = Tl();
      return ol === null ? hc(e, l, t) : Ad(
        e,
        ol.memoizedState,
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
    useSyncExternalStore: Fs,
    useId: xd,
    useHostTransitionStatus: yc,
    useFormState: rd,
    useActionState: rd,
    useOptimistic: function(l, t) {
      var e = Tl();
      return ol !== null ? ad(e, ol, l, t) : (e.baseState = l, [l, e.queue.dispatch]);
    },
    useMemoCache: cc,
    useCacheRefresh: Nd
  };
  Ud.useEffectEvent = vd;
  function bc(l, t, e, a) {
    t = l.memoizedState, e = e(a, t), e = e == null ? t : j({}, t, e), l.memoizedState = e, l.lanes === 0 && (l.updateQueue.baseState = e);
  }
  var pc = {
    enqueueSetState: function(l, t, e) {
      l = l._reactInternals;
      var a = st(), u = se(a);
      u.payload = t, e != null && (u.callback = e), t = de(l, u, a), t !== null && (Pl(t, l, a), eu(t, l, a));
    },
    enqueueReplaceState: function(l, t, e) {
      l = l._reactInternals;
      var a = st(), u = se(a);
      u.tag = 1, u.payload = t, e != null && (u.callback = e), t = de(l, u, a), t !== null && (Pl(t, l, a), eu(t, l, a));
    },
    enqueueForceUpdate: function(l, t) {
      l = l._reactInternals;
      var e = st(), a = se(e);
      a.tag = 2, t != null && (a.callback = t), t = de(l, a, e), t !== null && (Pl(t, l, e), eu(t, l, e));
    }
  };
  function Rd(l, t, e, a, u, n, i) {
    return l = l.stateNode, typeof l.shouldComponentUpdate == "function" ? l.shouldComponentUpdate(a, n, i) : t.prototype && t.prototype.isPureReactComponent ? !$a(e, a) || !$a(u, n) : !0;
  }
  function Cd(l, t, e, a) {
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
      e === t && (e = j({}, e));
      for (var u in l)
        e[u] === void 0 && (e[u] = l[u]);
    }
    return e;
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
      var e = l.onUncaughtError;
      e(t.value, { componentStack: t.stack });
    } catch (a) {
      setTimeout(function() {
        throw a;
      });
    }
  }
  function Yd(l, t, e) {
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
  function jc(l, t, e) {
    return e = se(e), e.tag = 3, e.payload = { element: null }, e.callback = function() {
      Sn(l, t);
    }, e;
  }
  function Gd(l) {
    return l = se(l), l.tag = 3, l;
  }
  function Qd(l, t, e, a) {
    var u = e.type.getDerivedStateFromError;
    if (typeof u == "function") {
      var n = a.value;
      l.payload = function() {
        return u(n);
      }, l.callback = function() {
        Yd(t, e, a);
      };
    }
    var i = e.stateNode;
    i !== null && typeof i.componentDidCatch == "function" && (l.callback = function() {
      Yd(t, e, a), typeof u != "function" && (ye === null ? ye = /* @__PURE__ */ new Set([this]) : ye.add(this));
      var f = a.stack;
      this.componentDidCatch(a.value, {
        componentStack: f !== null ? f : ""
      });
    });
  }
  function oh(l, t, e, a, u) {
    if (e.flags |= 32768, a !== null && typeof a == "object" && typeof a.then == "function") {
      if (t = e.alternate, t !== null && ma(
        t,
        e,
        u,
        !0
      ), e = nt.current, e !== null) {
        switch (e.tag) {
          case 31:
          case 13:
            return pt === null ? Mn() : e.alternate === null && jl === 0 && (jl = 3), e.flags &= -257, e.flags |= 65536, e.lanes = u, a === un ? e.flags |= 16384 : (t = e.updateQueue, t === null ? e.updateQueue = /* @__PURE__ */ new Set([a]) : t.add(a), Jc(l, a, u)), !1;
          case 22:
            return e.flags |= 65536, a === un ? e.flags |= 16384 : (t = e.updateQueue, t === null ? (t = {
              transitions: null,
              markerInstances: null,
              retryQueue: /* @__PURE__ */ new Set([a])
            }, e.updateQueue = t) : (e = t.retryQueue, e === null ? t.retryQueue = /* @__PURE__ */ new Set([a]) : e.add(a)), Jc(l, a, u)), !1;
        }
        throw Error(o(435, e.tag));
      }
      return Jc(l, a, u), Mn(), !1;
    }
    if (tl)
      return t = nt.current, t !== null ? ((t.flags & 65536) === 0 && (t.flags |= 256), t.flags |= 65536, t.lanes = u, a !== Qi && (l = Error(o(422), { cause: a }), Fa(yt(l, e)))) : (a !== Qi && (t = Error(o(423), {
        cause: a
      }), Fa(
        yt(t, e)
      )), l = l.current.alternate, l.flags |= 65536, u &= -u, l.lanes |= u, a = yt(a, e), u = jc(
        l.stateNode,
        a,
        u
      ), Fi(l, u), jl !== 4 && (jl = 2)), !1;
    var n = Error(o(520), { cause: a });
    if (n = yt(n, e), yu === null ? yu = [n] : yu.push(n), jl !== 4 && (jl = 2), t === null) return !0;
    a = yt(a, e), e = t;
    do {
      switch (e.tag) {
        case 3:
          return e.flags |= 65536, l = u & -u, e.lanes |= l, l = jc(e.stateNode, a, l), Fi(e, l), !1;
        case 1:
          if (t = e.type, n = e.stateNode, (e.flags & 128) === 0 && (typeof t.getDerivedStateFromError == "function" || n !== null && typeof n.componentDidCatch == "function" && (ye === null || !ye.has(n))))
            return e.flags |= 65536, u &= -u, e.lanes |= u, u = Gd(u), Qd(
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
  var Ac = Error(o(461)), Ol = !1;
  function Bl(l, t, e, a) {
    t.child = l === null ? Vs(t, null, e, a) : Le(
      t,
      l.child,
      e,
      a
    );
  }
  function Xd(l, t, e, a, u) {
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
    ), f = uc(), l !== null && !Ol ? (nc(l, t, u), Kt(l, t, u)) : (tl && f && Yi(t), t.flags |= 1, Bl(l, t, a, u), t.child);
  }
  function Ld(l, t, e, a, u) {
    if (l === null) {
      var n = e.type;
      return typeof n == "function" && !Hi(n) && n.defaultProps === void 0 && e.compare === null ? (t.tag = 15, t.type = n, Zd(
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
  function Zd(l, t, e, a, u) {
    if (l !== null) {
      var n = l.memoizedProps;
      if ($a(n, a) && l.ref === t.ref)
        if (Ol = !1, t.pendingProps = a = n, Mc(l, u))
          (l.flags & 131072) !== 0 && (Ol = !0);
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
  function Vd(l, t, e, a) {
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
        return Kd(
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
        ), n !== null ? ws(t, n) : Pi(), $s(t);
      else
        return a = t.lanes = 536870912, Kd(
          l,
          t,
          n !== null ? n.baseLanes | e : e,
          e,
          a
        );
    } else
      n !== null ? (en(t, n.cachePool), ws(t, n), re(), t.memoizedState = null) : (l !== null && en(t, null), Pi(), re());
    return Bl(l, t, u, e), t.child;
  }
  function su(l, t) {
    return l !== null && l.tag === 22 || t.stateNode !== null || (t.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), t.sibling;
  }
  function Kd(l, t, e, a, u) {
    var n = wi();
    return n = n === null ? null : { parent: Nl._currentValue, pool: n }, t.memoizedState = {
      baseLanes: e,
      cachePool: n
    }, l !== null && en(t, null), Pi(), $s(t), l !== null && ma(l, t, a, !0), t.childLanes = u, null;
  }
  function bn(l, t) {
    return t = jn(
      { mode: t.mode, children: t.children },
      l.mode
    ), t.ref = l.ref, l.child = t, t.return = l, t;
  }
  function Jd(l, t, e) {
    return Le(t, l.child, null, e), l = bn(t, t.pendingProps), l.flags |= 2, it(t), t.memoizedState = null, l;
  }
  function rh(l, t, e) {
    var a = t.pendingProps, u = (t.flags & 128) !== 0;
    if (t.flags &= -129, l === null) {
      if (tl) {
        if (a.mode === "hidden")
          return l = bn(t, a), t.lanes = 536870912, su(null, l);
        if (tc(t), (l = yl) ? (l = nr(
          l,
          bt
        ), l = l !== null && l.data === "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ue !== null ? { id: Mt, overflow: Dt } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, e = Os(l), e.return = t, t.child = e, Hl = t, yl = null)) : l = null, l === null) throw ie(t);
        return t.lanes = 536870912, null;
      }
      return bn(t, a);
    }
    var n = l.memoizedState;
    if (n !== null) {
      var i = n.dehydrated;
      if (tc(t), u)
        if (t.flags & 256)
          t.flags &= -257, t = Jd(
            l,
            t,
            e
          );
        else if (t.memoizedState !== null)
          t.child = l.child, t.flags |= 128, t = null;
        else throw Error(o(558));
      else if (Ol || ma(l, t, e, !1), u = (e & l.childLanes) !== 0, Ol || u) {
        if (a = vl, a !== null && (i = qf(a, e), i !== 0 && i !== n.retryLane))
          throw n.retryLane = i, Ce(l, i), Pl(a, l, i), Ac;
        Mn(), t = Jd(
          l,
          t,
          e
        );
      } else
        l = n.treeContext, yl = jt(i.nextSibling), Hl = t, tl = !0, ne = null, bt = !1, l !== null && Us(t, l), t = bn(t, a), t.flags |= 4096;
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
        throw Error(o(284));
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
    ), a = uc(), l !== null && !Ol ? (nc(l, t, u), Kt(l, t, u)) : (tl && a && Yi(t), t.flags |= 1, Bl(l, t, e, u), t.child);
  }
  function wd(l, t, e, a, u, n) {
    return Ye(t), t.updateQueue = null, e = ks(
      t,
      a,
      e,
      u
    ), Ws(l), a = uc(), l !== null && !Ol ? (nc(l, t, n), Kt(l, t, n)) : (tl && a && Yi(t), t.flags |= 1, Bl(l, t, e, n), t.child);
  }
  function $d(l, t, e, a, u) {
    if (Ye(t), t.stateNode === null) {
      var n = sa, i = e.contextType;
      typeof i == "object" && i !== null && (n = ql(i)), n = new e(a, n), t.memoizedState = n.state !== null && n.state !== void 0 ? n.state : null, n.updater = pc, t.stateNode = n, n._reactInternals = t, n = t.stateNode, n.props = a, n.state = t.memoizedState, n.refs = {}, Wi(t), i = e.contextType, n.context = typeof i == "object" && i !== null ? ql(i) : sa, n.state = t.memoizedState, i = e.getDerivedStateFromProps, typeof i == "function" && (bc(
        t,
        e,
        i,
        a
      ), n.state = t.memoizedState), typeof e.getDerivedStateFromProps == "function" || typeof n.getSnapshotBeforeUpdate == "function" || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (i = n.state, typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount(), i !== n.state && pc.enqueueReplaceState(n, n.state, null), uu(t, a, n, u), au(), n.state = t.memoizedState), typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !0;
    } else if (l === null) {
      n = t.stateNode;
      var f = t.memoizedProps, s = Ve(e, f);
      n.props = s;
      var y = n.context, p = e.contextType;
      i = sa, typeof p == "object" && p !== null && (i = ql(p));
      var T = e.getDerivedStateFromProps;
      p = typeof T == "function" || typeof n.getSnapshotBeforeUpdate == "function", f = t.pendingProps !== f, p || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (f || y !== i) && Cd(
        t,
        n,
        a,
        i
      ), fe = !1;
      var g = t.memoizedState;
      n.state = g, uu(t, a, n, u), au(), y = t.memoizedState, f || g !== y || fe ? (typeof T == "function" && (bc(
        t,
        e,
        T,
        a
      ), y = t.memoizedState), (s = fe || Rd(
        t,
        e,
        s,
        a,
        g,
        y,
        i
      )) ? (p || typeof n.UNSAFE_componentWillMount != "function" && typeof n.componentWillMount != "function" || (typeof n.componentWillMount == "function" && n.componentWillMount(), typeof n.UNSAFE_componentWillMount == "function" && n.UNSAFE_componentWillMount()), typeof n.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = a, t.memoizedState = y), n.props = a, n.state = y, n.context = i, a = s) : (typeof n.componentDidMount == "function" && (t.flags |= 4194308), a = !1);
    } else {
      n = t.stateNode, ki(l, t), i = t.memoizedProps, p = Ve(e, i), n.props = p, T = t.pendingProps, g = n.context, y = e.contextType, s = sa, typeof y == "object" && y !== null && (s = ql(y)), f = e.getDerivedStateFromProps, (y = typeof f == "function" || typeof n.getSnapshotBeforeUpdate == "function") || typeof n.UNSAFE_componentWillReceiveProps != "function" && typeof n.componentWillReceiveProps != "function" || (i !== T || g !== s) && Cd(
        t,
        n,
        a,
        s
      ), fe = !1, g = t.memoizedState, n.state = g, uu(t, a, n, u), au();
      var S = t.memoizedState;
      i !== T || g !== S || fe || l !== null && l.dependencies !== null && ln(l.dependencies) ? (typeof f == "function" && (bc(
        t,
        e,
        f,
        a
      ), S = t.memoizedState), (p = fe || Rd(
        t,
        e,
        p,
        a,
        g,
        S,
        s
      ) || l !== null && l.dependencies !== null && ln(l.dependencies)) ? (y || typeof n.UNSAFE_componentWillUpdate != "function" && typeof n.componentWillUpdate != "function" || (typeof n.componentWillUpdate == "function" && n.componentWillUpdate(a, S, s), typeof n.UNSAFE_componentWillUpdate == "function" && n.UNSAFE_componentWillUpdate(
        a,
        S,
        s
      )), typeof n.componentDidUpdate == "function" && (t.flags |= 4), typeof n.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), t.memoizedProps = a, t.memoizedState = S), n.props = a, n.state = S, n.context = s, a = p) : (typeof n.componentDidUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 4), typeof n.getSnapshotBeforeUpdate != "function" || i === l.memoizedProps && g === l.memoizedState || (t.flags |= 1024), a = !1);
    }
    return n = a, pn(l, t), a = (t.flags & 128) !== 0, n || a ? (n = t.stateNode, e = a && typeof e.getDerivedStateFromError != "function" ? null : n.render(), t.flags |= 1, l !== null && a ? (t.child = Le(
      t,
      l.child,
      null,
      u
    ), t.child = Le(
      t,
      null,
      e,
      u
    )) : Bl(l, t, e, u), t.memoizedState = n.state, l = t.child) : l = Kt(
      l,
      t,
      u
    ), l;
  }
  function Wd(l, t, e, a) {
    return qe(), t.flags |= 256, Bl(l, t, e, a), t.child;
  }
  var Tc = {
    dehydrated: null,
    treeContext: null,
    retryLane: 0,
    hydrationErrors: null
  };
  function Ec(l) {
    return { baseLanes: l, cachePool: Ys() };
  }
  function xc(l, t, e) {
    return l = l !== null ? l.childLanes & ~e : 0, t && (l |= ft), l;
  }
  function kd(l, t, e) {
    var a = t.pendingProps, u = !1, n = (t.flags & 128) !== 0, i;
    if ((i = n) || (i = l !== null && l.memoizedState === null ? !1 : (zl.current & 2) !== 0), i && (u = !0, t.flags &= -129), i = (t.flags & 32) !== 0, t.flags &= -33, l === null) {
      if (tl) {
        if (u ? oe(t) : re(), (l = yl) ? (l = nr(
          l,
          bt
        ), l = l !== null && l.data !== "&" ? l : null, l !== null && (t.memoizedState = {
          dehydrated: l,
          treeContext: ue !== null ? { id: Mt, overflow: Dt } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, e = Os(l), e.return = t, t.child = e, Hl = t, yl = null)) : l = null, l === null) throw ie(t);
        return sf(l) ? t.lanes = 32 : t.lanes = 536870912, null;
      }
      var f = a.children;
      return a = a.fallback, u ? (re(), u = t.mode, f = jn(
        { mode: "hidden", children: f },
        u
      ), a = He(
        a,
        u,
        e,
        null
      ), f.return = t, a.return = t, f.sibling = a, t.child = f, a = t.child, a.memoizedState = Ec(e), a.childLanes = xc(
        l,
        i,
        e
      ), t.memoizedState = Tc, su(null, a)) : (oe(t), Nc(t, f));
    }
    var s = l.memoizedState;
    if (s !== null && (f = s.dehydrated, f !== null)) {
      if (n)
        t.flags & 256 ? (oe(t), t.flags &= -257, t = _c(
          l,
          t,
          e
        )) : t.memoizedState !== null ? (re(), t.child = l.child, t.flags |= 128, t = null) : (re(), f = a.fallback, u = t.mode, a = jn(
          { mode: "visible", children: a.children },
          u
        ), f = He(
          f,
          u,
          e,
          null
        ), f.flags |= 2, a.return = t, f.return = t, a.sibling = f, t.child = a, Le(
          t,
          l.child,
          null,
          e
        ), a = t.child, a.memoizedState = Ec(e), a.childLanes = xc(
          l,
          i,
          e
        ), t.memoizedState = Tc, t = su(null, a));
      else if (oe(t), sf(f)) {
        if (i = f.nextSibling && f.nextSibling.dataset, i) var y = i.dgst;
        i = y, a = Error(o(419)), a.stack = "", a.digest = i, Fa({ value: a, source: null, stack: null }), t = _c(
          l,
          t,
          e
        );
      } else if (Ol || ma(l, t, e, !1), i = (e & l.childLanes) !== 0, Ol || i) {
        if (i = vl, i !== null && (a = qf(i, e), a !== 0 && a !== s.retryLane))
          throw s.retryLane = a, Ce(l, a), Pl(i, l, a), Ac;
        ff(f) || Mn(), t = _c(
          l,
          t,
          e
        );
      } else
        ff(f) ? (t.flags |= 192, t.child = l.child, t = null) : (l = s.treeContext, yl = jt(
          f.nextSibling
        ), Hl = t, tl = !0, ne = null, bt = !1, l !== null && Us(t, l), t = Nc(
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
    ) : (f = He(
      f,
      u,
      e,
      null
    ), f.flags |= 2), f.return = t, a.return = t, a.sibling = f, t.child = a, su(null, a), a = t.child, f = l.child.memoizedState, f === null ? f = Ec(e) : (u = f.cachePool, u !== null ? (s = Nl._currentValue, u = u.parent !== s ? { parent: s, pool: s } : u) : u = Ys(), f = {
      baseLanes: f.baseLanes | e,
      cachePool: u
    }), a.memoizedState = f, a.childLanes = xc(
      l,
      i,
      e
    ), t.memoizedState = Tc, su(l.child, a)) : (oe(t), e = l.child, l = e.sibling, e = Gt(e, {
      mode: "visible",
      children: a.children
    }), e.return = t, e.sibling = null, l !== null && (i = t.deletions, i === null ? (t.deletions = [l], t.flags |= 16) : i.push(l)), t.child = e, t.memoizedState = null, e);
  }
  function Nc(l, t) {
    return t = jn(
      { mode: "visible", children: t },
      l.mode
    ), t.return = l, l.child = t;
  }
  function jn(l, t) {
    return l = ut(22, l, null, t), l.lanes = 0, l;
  }
  function _c(l, t, e) {
    return Le(t, l.child, null, e), l = Nc(
      t,
      t.pendingProps.children
    ), l.flags |= 2, t.memoizedState = null, l;
  }
  function Fd(l, t, e) {
    l.lanes |= t;
    var a = l.alternate;
    a !== null && (a.lanes |= t), Zi(l.return, t, e);
  }
  function Oc(l, t, e, a, u, n) {
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
  function Id(l, t, e) {
    var a = t.pendingProps, u = a.revealOrder, n = a.tail;
    a = a.children;
    var i = zl.current, f = (i & 2) !== 0;
    if (f ? (i = i & 1 | 2, t.flags |= 128) : i &= 1, U(zl, i), Bl(l, t, a, e), a = tl ? ka : 0, !f && l !== null && (l.flags & 128) !== 0)
      l: for (l = t.child; l !== null; ) {
        if (l.tag === 13)
          l.memoizedState !== null && Fd(l, e, t);
        else if (l.tag === 19)
          Fd(l, e, t);
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
        e = u, e === null ? (u = t.child, t.child = null) : (u = e.sibling, e.sibling = null), Oc(
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
        Oc(
          t,
          !0,
          e,
          null,
          n,
          a
        );
        break;
      case "together":
        Oc(
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
  function Mc(l, t) {
    return (l.lanes & t) !== 0 ? !0 : (l = l.dependencies, !!(l !== null && ln(l)));
  }
  function mh(l, t, e) {
    switch (t.tag) {
      case 3:
        Ll(t, t.stateNode.containerInfo), ce(t, Nl, l.memoizedState.cache), qe();
        break;
      case 27:
      case 5:
        Ha(t);
        break;
      case 4:
        Ll(t, t.stateNode.containerInfo);
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
          return a.dehydrated !== null ? (oe(t), t.flags |= 128, null) : (e & t.child.childLanes) !== 0 ? kd(l, t, e) : (oe(t), l = Kt(
            l,
            t,
            e
          ), l !== null ? l.sibling : null);
        oe(t);
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
            return Id(
              l,
              t,
              e
            );
          t.flags |= 128;
        }
        if (u = t.memoizedState, u !== null && (u.rendering = null, u.tail = null, u.lastEffect = null), U(zl, zl.current), a) break;
        return null;
      case 22:
        return t.lanes = 0, Vd(
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
  function Pd(l, t, e) {
    if (l !== null)
      if (l.memoizedProps !== t.pendingProps)
        Ol = !0;
      else {
        if (!Mc(l, e) && (t.flags & 128) === 0)
          return Ol = !1, mh(
            l,
            t,
            e
          );
        Ol = (l.flags & 131072) !== 0;
      }
    else
      Ol = !1, tl && (t.flags & 1048576) !== 0 && Ds(t, ka, t.index);
    switch (t.lanes = 0, t.tag) {
      case 16:
        l: {
          var a = t.pendingProps;
          if (l = Qe(t.elementType), t.type = l, typeof l == "function")
            Hi(l) ? (a = Ve(l, a), t.tag = 1, t = $d(
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
              if (u === rt) {
                t.tag = 11, t = Xd(
                  null,
                  t,
                  l,
                  a,
                  e
                );
                break l;
              } else if (u === ll) {
                t.tag = 14, t = Ld(
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
        ), $d(
          l,
          t,
          a,
          u,
          e
        );
      case 3:
        l: {
          if (Ll(
            t,
            t.stateNode.containerInfo
          ), l === null) throw Error(o(387));
          a = t.pendingProps;
          var n = t.memoizedState;
          u = n.element, ki(l, t), uu(t, a, null, e);
          var i = t.memoizedState;
          if (a = i.cache, ce(t, Nl, a), a !== n.cache && Vi(
            t,
            [Nl],
            e,
            !0
          ), au(), a = i.element, n.isDehydrated)
            if (n = {
              element: a,
              isDehydrated: !1,
              cache: i.cache
            }, t.updateQueue.baseState = n, t.memoizedState = n, t.flags & 256) {
              t = Wd(
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
              ), Fa(u), t = Wd(
                l,
                t,
                a,
                e
              );
              break l;
            } else
              for (l = t.stateNode.containerInfo, l.nodeType === 9 ? l = l.body : l = l.nodeName === "HTML" ? l.ownerDocument.body : l, yl = jt(l.firstChild), Hl = t, tl = !0, ne = null, bt = !0, e = Vs(
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
            Bl(l, t, a, e);
          }
          t = t.child;
        }
        return t;
      case 26:
        return pn(l, t), l === null ? (e = or(
          t.type,
          null,
          t.pendingProps,
          null
        )) ? t.memoizedState = e : tl || (e = t.type, l = t.pendingProps, a = Bn(
          w.current
        ).createElement(e), a[Cl] = t, a[wl] = l, Yl(a, e, l), Ul(a), t.stateNode = a) : t.memoizedState = or(
          t.type,
          l.memoizedProps,
          t.pendingProps,
          l.memoizedState
        ), null;
      case 27:
        return Ha(t), l === null && tl && (a = t.stateNode = fr(
          t.type,
          t.pendingProps,
          w.current
        ), Hl = t, bt = !0, u = yl, pe(t.type) ? (df = u, yl = jt(a.firstChild)) : yl = u), Bl(
          l,
          t,
          t.pendingProps.children,
          e
        ), pn(l, t), l === null && (t.flags |= 4194304), t.child;
      case 5:
        return l === null && tl && ((u = a = yl) && (a = Zh(
          a,
          t.type,
          t.pendingProps,
          bt
        ), a !== null ? (t.stateNode = a, Hl = t, yl = jt(a.firstChild), bt = !1, u = !0) : u = !1), u || ie(t)), Ha(t), u = t.type, n = t.pendingProps, i = l !== null ? l.memoizedProps : null, a = n.children, uf(u, n) ? a = null : i !== null && uf(u, i) && (t.flags |= 32), t.memoizedState !== null && (u = ac(
          l,
          t,
          uh,
          null,
          null,
          e
        ), Tu._currentValue = u), pn(l, t), Bl(l, t, a, e), t.child;
      case 6:
        return l === null && tl && ((l = e = yl) && (e = Vh(
          e,
          t.pendingProps,
          bt
        ), e !== null ? (t.stateNode = e, Hl = t, yl = null, l = !0) : l = !1), l || ie(t)), null;
      case 13:
        return kd(l, t, e);
      case 4:
        return Ll(
          t,
          t.stateNode.containerInfo
        ), a = t.pendingProps, l === null ? t.child = Le(
          t,
          null,
          a,
          e
        ) : Bl(l, t, a, e), t.child;
      case 11:
        return Xd(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 7:
        return Bl(
          l,
          t,
          t.pendingProps,
          e
        ), t.child;
      case 8:
        return Bl(
          l,
          t,
          t.pendingProps.children,
          e
        ), t.child;
      case 12:
        return Bl(
          l,
          t,
          t.pendingProps.children,
          e
        ), t.child;
      case 10:
        return a = t.pendingProps, ce(t, t.type, a.value), Bl(l, t, a.children, e), t.child;
      case 9:
        return u = t.type._context, a = t.pendingProps.children, Ye(t), u = ql(u), a = a(u), t.flags |= 1, Bl(l, t, a, e), t.child;
      case 14:
        return Ld(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 15:
        return Zd(
          l,
          t,
          t.type,
          t.pendingProps,
          e
        );
      case 19:
        return Id(l, t, e);
      case 31:
        return rh(l, t, e);
      case 22:
        return Vd(
          l,
          t,
          e,
          t.pendingProps
        );
      case 24:
        return Ye(t), a = ql(Nl), l === null ? (u = wi(), u === null && (u = vl, n = Ki(), u.pooledCache = n, n.refCount++, n !== null && (u.pooledCacheLanes |= e), u = n), t.memoizedState = { parent: a, cache: u }, Wi(t), ce(t, Nl, u)) : ((l.lanes & e) !== 0 && (ki(l, t), uu(t, null, null, e), au()), u = l.memoizedState, n = t.memoizedState, u.parent !== a ? (u = { parent: a, cache: a }, t.memoizedState = u, t.lanes === 0 && (t.memoizedState = t.updateQueue.baseState = u), ce(t, Nl, a)) : (a = n.cache, ce(t, Nl, a), a !== u.cache && Vi(
          t,
          [Nl],
          e,
          !0
        ))), Bl(
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
  function Dc(l, t, e, a, u) {
    if ((t = (l.mode & 32) !== 0) && (t = !1), t) {
      if (l.flags |= 16777216, (u & 335544128) === u)
        if (l.stateNode.complete) l.flags |= 8192;
        else if (No()) l.flags |= 8192;
        else
          throw Xe = un, $i;
    } else l.flags &= -16777217;
  }
  function lo(l, t) {
    if (t.type !== "stylesheet" || (t.state.loading & 4) !== 0)
      l.flags &= -16777217;
    else if (l.flags |= 16777216, !yr(t))
      if (No()) l.flags |= 8192;
      else
        throw Xe = un, $i;
  }
  function An(l, t) {
    t !== null && (l.flags |= 4), l.flags & 16384 && (t = l.tag !== 22 ? Rf() : 536870912, l.lanes |= t, Ea |= t);
  }
  function du(l, t) {
    if (!tl)
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
        return e = t.stateNode, a = null, l !== null && (a = l.memoizedState.cache), t.memoizedState.cache !== a && (t.flags |= 2048), Lt(Nl), Al(), e.pendingContext && (e.context = e.pendingContext, e.pendingContext = null), (l === null || l.child === null) && (ra(t) ? Jt(t) : l === null || l.memoizedState.isDehydrated && (t.flags & 256) === 0 || (t.flags |= 1024, Xi())), gl(t), null;
      case 26:
        var u = t.type, n = t.memoizedState;
        return l === null ? (Jt(t), n !== null ? (gl(t), lo(t, n)) : (gl(t), Dc(
          t,
          u,
          null,
          a,
          e
        ))) : n ? n !== l.memoizedState ? (Jt(t), gl(t), lo(t, n)) : (gl(t), t.flags &= -16777217) : (l = l.memoizedProps, l !== a && Jt(t), gl(t), Dc(
          t,
          u,
          l,
          a,
          e
        )), null;
      case 27:
        if (Uu(t), e = w.current, u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Jt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(o(166));
            return gl(t), null;
          }
          l = q.current, ra(t) ? Rs(t) : (l = fr(u, a, e), t.stateNode = l, Jt(t));
        }
        return gl(t), null;
      case 5:
        if (Uu(t), u = t.type, l !== null && t.stateNode != null)
          l.memoizedProps !== a && Jt(t);
        else {
          if (!a) {
            if (t.stateNode === null)
              throw Error(o(166));
            return gl(t), null;
          }
          if (n = q.current, ra(t))
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
                    n = typeof a.is == "string" ? i.createElement("select", {
                      is: a.is
                    }) : i.createElement("select"), a.multiple ? n.multiple = !0 : a.size && (n.size = a.size);
                    break;
                  default:
                    n = typeof a.is == "string" ? i.createElement(u, { is: a.is }) : i.createElement(u);
                }
            }
            n[Cl] = t, n[wl] = a;
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
            l: switch (Yl(n, u, a), u) {
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
            throw Error(o(166));
          if (l = w.current, ra(t)) {
            if (l = t.stateNode, e = t.memoizedProps, a = null, u = Hl, u !== null)
              switch (u.tag) {
                case 27:
                case 5:
                  a = u.memoizedProps;
              }
            l[Cl] = t, l = !!(l.nodeValue === e || a !== null && a.suppressHydrationWarning === !0 || Fo(l.nodeValue, e)), l || ie(t, !0);
          } else
            l = Bn(l).createTextNode(
              a
            ), l[Cl] = t, t.stateNode = l;
        }
        return gl(t), null;
      case 31:
        if (e = t.memoizedState, l === null || l.memoizedState !== null) {
          if (a = ra(t), e !== null) {
            if (l === null) {
              if (!a) throw Error(o(318));
              if (l = t.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(o(557));
              l[Cl] = t;
            } else
              qe(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            gl(t), l = !1;
          } else
            e = Xi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = e), l = !0;
          if (!l)
            return t.flags & 256 ? (it(t), t) : (it(t), null);
          if ((t.flags & 128) !== 0)
            throw Error(o(558));
        }
        return gl(t), null;
      case 13:
        if (a = t.memoizedState, l === null || l.memoizedState !== null && l.memoizedState.dehydrated !== null) {
          if (u = ra(t), a !== null && a.dehydrated !== null) {
            if (l === null) {
              if (!u) throw Error(o(318));
              if (u = t.memoizedState, u = u !== null ? u.dehydrated : null, !u) throw Error(o(317));
              u[Cl] = t;
            } else
              qe(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            gl(t), u = !1;
          } else
            u = Xi(), l !== null && l.memoizedState !== null && (l.memoizedState.hydrationErrors = u), u = !0;
          if (!u)
            return t.flags & 256 ? (it(t), t) : (it(t), null);
        }
        return it(t), (t.flags & 128) !== 0 ? (t.lanes = e, t) : (e = a !== null, l = l !== null && l.memoizedState !== null, e && (a = t.child, u = null, a.alternate !== null && a.alternate.memoizedState !== null && a.alternate.memoizedState.cachePool !== null && (u = a.alternate.memoizedState.cachePool.pool), n = null, a.memoizedState !== null && a.memoizedState.cachePool !== null && (n = a.memoizedState.cachePool.pool), n !== u && (a.flags |= 2048)), e !== l && e && (t.child.flags |= 8192), An(t, t.updateQueue), gl(t), null);
      case 4:
        return Al(), l === null && Pc(t.stateNode.containerInfo), gl(t), null;
      case 10:
        return Lt(t.type), gl(t), null;
      case 19:
        if (E(zl), a = t.memoizedState, a === null) return gl(t), null;
        if (u = (t.flags & 128) !== 0, n = a.rendering, n === null)
          if (u) du(a, !1);
          else {
            if (jl !== 0 || l !== null && (l.flags & 128) !== 0)
              for (l = t.child; l !== null; ) {
                if (n = sn(l), n !== null) {
                  for (t.flags |= 128, du(a, !1), l = n.updateQueue, t.updateQueue = l, An(t, l), t.subtreeFlags = 0, l = e, e = t.child; e !== null; )
                    _s(e, l), e = e.sibling;
                  return U(
                    zl,
                    zl.current & 1 | 2
                  ), tl && Qt(t, a.treeForkCount), t.child;
                }
                l = l.sibling;
              }
            a.tail !== null && lt() > Nn && (t.flags |= 128, u = !0, du(a, !1), t.lanes = 4194304);
          }
        else {
          if (!u)
            if (l = sn(n), l !== null) {
              if (t.flags |= 128, u = !0, l = l.updateQueue, t.updateQueue = l, An(t, l), du(a, !0), a.tail === null && a.tailMode === "hidden" && !n.alternate && !tl)
                return gl(t), null;
            } else
              2 * lt() - a.renderingStartTime > Nn && e !== 536870912 && (t.flags |= 128, u = !0, du(a, !1), t.lanes = 4194304);
          a.isBackwards ? (n.sibling = t.child, t.child = n) : (l = a.last, l !== null ? l.sibling = n : t.child = n, a.last = n);
        }
        return a.tail !== null ? (l = a.tail, a.rendering = l, a.tail = l.sibling, a.renderingStartTime = lt(), l.sibling = null, e = zl.current, U(
          zl,
          u ? e & 1 | 2 : e & 1
        ), tl && Qt(t, a.treeForkCount), l) : (gl(t), null);
      case 22:
      case 23:
        return it(t), lc(), a = t.memoizedState !== null, l !== null ? l.memoizedState !== null !== a && (t.flags |= 8192) : a && (t.flags |= 8192), a ? (e & 536870912) !== 0 && (t.flags & 128) === 0 && (gl(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : gl(t), e = t.updateQueue, e !== null && An(t, e.retryQueue), e = null, l !== null && l.memoizedState !== null && l.memoizedState.cachePool !== null && (e = l.memoizedState.cachePool.pool), a = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (a = t.memoizedState.cachePool.pool), a !== e && (t.flags |= 2048), l !== null && E(Ge), null;
      case 24:
        return e = null, l !== null && (e = l.memoizedState.cache), t.memoizedState.cache !== e && (t.flags |= 2048), Lt(Nl), gl(t), null;
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
        return Lt(Nl), Al(), l = t.flags, (l & 65536) !== 0 && (l & 128) === 0 ? (t.flags = l & -65537 | 128, t) : null;
      case 26:
      case 27:
      case 5:
        return Uu(t), null;
      case 31:
        if (t.memoizedState !== null) {
          if (it(t), t.alternate === null)
            throw Error(o(340));
          qe();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 13:
        if (it(t), l = t.memoizedState, l !== null && l.dehydrated !== null) {
          if (t.alternate === null)
            throw Error(o(340));
          qe();
        }
        return l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 19:
        return E(zl), null;
      case 4:
        return Al(), null;
      case 10:
        return Lt(t.type), null;
      case 22:
      case 23:
        return it(t), lc(), l !== null && E(Ge), l = t.flags, l & 65536 ? (t.flags = l & -65537 | 128, t) : null;
      case 24:
        return Lt(Nl), null;
      case 25:
        return null;
      default:
        return null;
    }
  }
  function to(l, t) {
    switch (Gi(t), t.tag) {
      case 3:
        Lt(Nl), Al();
        break;
      case 26:
      case 27:
      case 5:
        Uu(t);
        break;
      case 4:
        Al();
        break;
      case 31:
        t.memoizedState !== null && it(t);
        break;
      case 13:
        it(t);
        break;
      case 19:
        E(zl);
        break;
      case 10:
        Lt(t.type);
        break;
      case 22:
      case 23:
        it(t), lc(), l !== null && E(Ge);
        break;
      case 24:
        Lt(Nl);
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
              var s = e, y = f;
              try {
                y();
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
  function eo(l) {
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
  function ao(l, t, e) {
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
  function Ut(l, t) {
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
  function uo(l) {
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
      Bh(a, l.type, e, t), a[wl] = t;
    } catch (u) {
      sl(l, l.return, u);
    }
  }
  function no(l) {
    return l.tag === 5 || l.tag === 3 || l.tag === 26 || l.tag === 27 && pe(l.type) || l.tag === 4;
  }
  function Rc(l) {
    l: for (; ; ) {
      for (; l.sibling === null; ) {
        if (l.return === null || no(l.return)) return null;
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
  function io(l) {
    var t = l.stateNode, e = l.memoizedProps;
    try {
      for (var a = l.type, u = t.attributes; u.length; )
        t.removeAttributeNode(u[0]);
      Yl(t, a, e), t[Cl] = l, t[wl] = e;
    } catch (n) {
      sl(l, l.return, n);
    }
  }
  var wt = !1, Ml = !1, Hc = !1, co = typeof WeakSet == "function" ? WeakSet : Set, Rl = null;
  function yh(l, t) {
    if (l = l.containerInfo, ef = Vn, l = bs(l), _i(l)) {
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
            var i = 0, f = -1, s = -1, y = 0, p = 0, T = l, g = null;
            t: for (; ; ) {
              for (var S; T !== e || u !== 0 && T.nodeType !== 3 || (f = i + u), T !== n || a !== 0 && T.nodeType !== 3 || (s = i + a), T.nodeType === 3 && (i += T.nodeValue.length), (S = T.firstChild) !== null; )
                g = T, T = S;
              for (; ; ) {
                if (T === l) break t;
                if (g === e && ++y === u && (f = i), g === n && ++p === a && (s = i), (S = T.nextSibling) !== null) break;
                T = g, g = T.parentNode;
              }
              T = S;
            }
            e = f === -1 || s === -1 ? null : { start: f, end: s };
          } else e = null;
        }
      e = e || { start: 0, end: 0 };
    } else e = null;
    for (af = { focusedElem: l, selectionRange: e }, Vn = !1, Rl = t; Rl !== null; )
      if (t = Rl, l = t.child, (t.subtreeFlags & 1028) !== 0 && l !== null)
        l.return = t, Rl = l;
      else
        for (; Rl !== null; ) {
          switch (t = Rl, n = t.alternate, l = t.flags, t.tag) {
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
                  var C = Ve(
                    e.type,
                    u
                  );
                  l = a.getSnapshotBeforeUpdate(
                    C,
                    n
                  ), a.__reactInternalSnapshotBeforeUpdate = l;
                } catch (G) {
                  sl(
                    e,
                    e.return,
                    G
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
              if ((l & 1024) !== 0) throw Error(o(163));
          }
          if (l = t.sibling, l !== null) {
            l.return = t.return, Rl = l;
            break;
          }
          Rl = t.return;
        }
  }
  function fo(l, t, e) {
    var a = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 15:
        Wt(l, e), a & 4 && ou(5, e);
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
        a & 64 && eo(e), a & 512 && ru(e, e.return);
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
            Js(l, t);
          } catch (i) {
            sl(e, e.return, i);
          }
        }
        break;
      case 27:
        t === null && a & 4 && io(e);
      case 26:
      case 5:
        Wt(l, e), t === null && a & 4 && uo(e), a & 512 && ru(e, e.return);
        break;
      case 12:
        Wt(l, e);
        break;
      case 31:
        Wt(l, e), a & 4 && ro(l, e);
        break;
      case 13:
        Wt(l, e), a & 4 && mo(l, e), a & 64 && (l = e.memoizedState, l !== null && (l = l.dehydrated, l !== null && (e = Eh.bind(
          null,
          e
        ), Kh(l, e))));
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
  function so(l) {
    var t = l.alternate;
    t !== null && (l.alternate = null, so(t)), l.child = null, l.deletions = null, l.sibling = null, l.tag === 5 && (t = l.stateNode, t !== null && oi(t)), l.stateNode = null, l.return = null, l.dependencies = null, l.memoizedProps = null, l.memoizedState = null, l.pendingProps = null, l.stateNode = null, l.updateQueue = null;
  }
  var Sl = null, Wl = !1;
  function $t(l, t, e) {
    for (e = e.child; e !== null; )
      oo(l, t, e), e = e.sibling;
  }
  function oo(l, t, e) {
    if (tt && typeof tt.onCommitFiberUnmount == "function")
      try {
        tt.onCommitFiberUnmount(qa, e);
      } catch {
      }
    switch (e.tag) {
      case 26:
        Ml || Ut(e, t), $t(
          l,
          t,
          e
        ), e.memoizedState ? e.memoizedState.count-- : e.stateNode && (e = e.stateNode, e.parentNode.removeChild(e));
        break;
      case 27:
        Ml || Ut(e, t);
        var a = Sl, u = Wl;
        pe(e.type) && (Sl = e.stateNode, Wl = !1), $t(
          l,
          t,
          e
        ), ju(e.stateNode), Sl = a, Wl = u;
        break;
      case 5:
        Ml || Ut(e, t);
      case 6:
        if (a = Sl, u = Wl, Sl = null, $t(
          l,
          t,
          e
        ), Sl = a, Wl = u, Sl !== null)
          if (Wl)
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
        Sl !== null && (Wl ? (l = Sl, ar(
          l.nodeType === 9 ? l.body : l.nodeName === "HTML" ? l.ownerDocument.body : l,
          e.stateNode
        ), Ra(l)) : ar(Sl, e.stateNode));
        break;
      case 4:
        a = Sl, u = Wl, Sl = e.stateNode.containerInfo, Wl = !0, $t(
          l,
          t,
          e
        ), Sl = a, Wl = u;
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
        Ml || (Ut(e, t), a = e.stateNode, typeof a.componentWillUnmount == "function" && ao(
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
  function ro(l, t) {
    if (t.memoizedState === null && (l = t.alternate, l !== null && (l = l.memoizedState, l !== null))) {
      l = l.dehydrated;
      try {
        Ra(l);
      } catch (e) {
        sl(t, t.return, e);
      }
    }
  }
  function mo(l, t) {
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
        return t === null && (t = l.stateNode = new co()), t;
      case 22:
        return l = l.stateNode, t = l._retryCache, t === null && (t = l._retryCache = new co()), t;
      default:
        throw Error(o(435, l.tag));
    }
  }
  function Tn(l, t) {
    var e = gh(l);
    t.forEach(function(a) {
      if (!e.has(a)) {
        e.add(a);
        var u = xh.bind(null, l, a);
        a.then(u, u);
      }
    });
  }
  function kl(l, t) {
    var e = t.deletions;
    if (e !== null)
      for (var a = 0; a < e.length; a++) {
        var u = e[a], n = l, i = t, f = i;
        l: for (; f !== null; ) {
          switch (f.tag) {
            case 27:
              if (pe(f.type)) {
                Sl = f.stateNode, Wl = !1;
                break l;
              }
              break;
            case 5:
              Sl = f.stateNode, Wl = !1;
              break l;
            case 3:
            case 4:
              Sl = f.stateNode.containerInfo, Wl = !0;
              break l;
          }
          f = f.return;
        }
        if (Sl === null) throw Error(o(160));
        oo(n, i, u), Sl = null, Wl = !1, n = u.alternate, n !== null && (n.return = null), u.return = null;
      }
    if (t.subtreeFlags & 13886)
      for (t = t.child; t !== null; )
        ho(t, l), t = t.sibling;
  }
  var Et = null;
  function ho(l, t) {
    var e = l.alternate, a = l.flags;
    switch (l.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        kl(t, l), Fl(l), a & 4 && (me(3, l, l.return), ou(3, l), me(5, l, l.return));
        break;
      case 1:
        kl(t, l), Fl(l), a & 512 && (Ml || e === null || Ut(e, e.return)), a & 64 && wt && (l = l.updateQueue, l !== null && (a = l.callbacks, a !== null && (e = l.shared.hiddenCallbacks, l.shared.hiddenCallbacks = e === null ? a : e.concat(a))));
        break;
      case 26:
        var u = Et;
        if (kl(t, l), Fl(l), a & 512 && (Ml || e === null || Ut(e, e.return)), a & 4) {
          var n = e !== null ? e.memoizedState : null;
          if (a = l.memoizedState, e === null)
            if (a === null)
              if (l.stateNode === null) {
                l: {
                  a = l.type, e = l.memoizedProps, u = u.ownerDocument || u;
                  t: switch (a) {
                    case "title":
                      n = u.getElementsByTagName("title")[0], (!n || n[Ga] || n[Cl] || n.namespaceURI === "http://www.w3.org/2000/svg" || n.hasAttribute("itemprop")) && (n = u.createElement(a), u.head.insertBefore(
                        n,
                        u.querySelector("head > title")
                      )), Yl(n, a, e), n[Cl] = l, Ul(n), a = n;
                      break l;
                    case "link":
                      var i = hr(
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
                      n = u.createElement(a), Yl(n, a, e), u.head.appendChild(n);
                      break;
                    case "meta":
                      if (i = hr(
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
                      n = u.createElement(a), Yl(n, a, e), u.head.appendChild(n);
                      break;
                    default:
                      throw Error(o(468, a));
                  }
                  n[Cl] = l, Ul(n), a = n;
                }
                l.stateNode = a;
              } else
                vr(
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
            n !== a ? (n === null ? e.stateNode !== null && (e = e.stateNode, e.parentNode.removeChild(e)) : n.count--, a === null ? vr(
              u,
              l.type,
              l.stateNode
            ) : mr(
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
        kl(t, l), Fl(l), a & 512 && (Ml || e === null || Ut(e, e.return)), e !== null && a & 4 && Uc(
          l,
          l.memoizedProps,
          e.memoizedProps
        );
        break;
      case 5:
        if (kl(t, l), Fl(l), a & 512 && (Ml || e === null || Ut(e, e.return)), l.flags & 32) {
          u = l.stateNode;
          try {
            ea(u, "");
          } catch (C) {
            sl(l, l.return, C);
          }
        }
        a & 4 && l.stateNode != null && (u = l.memoizedProps, Uc(
          l,
          u,
          e !== null ? e.memoizedProps : u
        )), a & 1024 && (Hc = !0);
        break;
      case 6:
        if (kl(t, l), Fl(l), a & 4) {
          if (l.stateNode === null)
            throw Error(o(162));
          a = l.memoizedProps, e = l.stateNode;
          try {
            e.nodeValue = a;
          } catch (C) {
            sl(l, l.return, C);
          }
        }
        break;
      case 3:
        if (Qn = null, u = Et, Et = Yn(t.containerInfo), kl(t, l), Et = u, Fl(l), a & 4 && e !== null && e.memoizedState.isDehydrated)
          try {
            Ra(t.containerInfo);
          } catch (C) {
            sl(l, l.return, C);
          }
        Hc && (Hc = !1, vo(l));
        break;
      case 4:
        a = Et, Et = Yn(
          l.stateNode.containerInfo
        ), kl(t, l), Fl(l), Et = a;
        break;
      case 12:
        kl(t, l), Fl(l);
        break;
      case 31:
        kl(t, l), Fl(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
        break;
      case 13:
        kl(t, l), Fl(l), l.child.flags & 8192 && l.memoizedState !== null != (e !== null && e.memoizedState !== null) && (xn = lt()), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
        break;
      case 22:
        u = l.memoizedState !== null;
        var s = e !== null && e.memoizedState !== null, y = wt, p = Ml;
        if (wt = y || u, Ml = p || s, kl(t, l), Ml = p, wt = y, Fl(l), a & 8192)
          l: for (t = l.stateNode, t._visibility = u ? t._visibility & -2 : t._visibility | 1, u && (e === null || s || wt || Ml || Ke(l)), e = null, t = l; ; ) {
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
                } catch (C) {
                  sl(s, s.return, C);
                }
              }
            } else if (t.tag === 6) {
              if (e === null) {
                s = t;
                try {
                  s.stateNode.nodeValue = u ? "" : s.memoizedProps;
                } catch (C) {
                  sl(s, s.return, C);
                }
              }
            } else if (t.tag === 18) {
              if (e === null) {
                s = t;
                try {
                  var S = s.stateNode;
                  u ? ur(S, !0) : ur(s.stateNode, !1);
                } catch (C) {
                  sl(s, s.return, C);
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
        kl(t, l), Fl(l), a & 4 && (a = l.updateQueue, a !== null && (l.updateQueue = null, Tn(l, a)));
        break;
      case 30:
        break;
      case 21:
        break;
      default:
        kl(t, l), Fl(l);
    }
  }
  function Fl(l) {
    var t = l.flags;
    if (t & 2) {
      try {
        for (var e, a = l.return; a !== null; ) {
          if (no(a)) {
            e = a;
            break;
          }
          a = a.return;
        }
        if (e == null) throw Error(o(160));
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
            var s = e.stateNode.containerInfo, y = Rc(l);
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
        sl(l, l.return, p);
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
  function Wt(l, t) {
    if (t.subtreeFlags & 8772)
      for (t = t.child; t !== null; )
        fo(l, t.alternate, t), t = t.sibling;
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
          Ut(t, t.return);
          var e = t.stateNode;
          typeof e.componentWillUnmount == "function" && ao(
            t,
            t.return,
            e
          ), Ke(t);
          break;
        case 27:
          ju(t.stateNode);
        case 26:
        case 5:
          Ut(t, t.return), Ke(t);
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
          ), ou(4, n);
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
              var s = u.shared.hiddenCallbacks;
              if (s !== null)
                for (u.shared.hiddenCallbacks = null, u = 0; u < s.length; u++)
                  Ks(s[u], f);
            } catch (y) {
              sl(a, a.return, y);
            }
          }
          e && i & 64 && eo(n), ru(n, n.return);
          break;
        case 27:
          io(n);
        case 26:
        case 5:
          kt(
            u,
            n,
            e
          ), e && a === null && i & 4 && uo(n), ru(n, n.return);
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
          ), e && i & 4 && ro(u, n);
          break;
        case 13:
          kt(
            u,
            n,
            e
          ), e && i & 4 && mo(u, n);
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
  function xt(l, t, e, a) {
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; )
        yo(
          l,
          t,
          e,
          a
        ), t = t.sibling;
  }
  function yo(l, t, e, a) {
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
        ), u & 2048 && (l = null, t.alternate !== null && (l = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== l && (t.refCount++, l != null && Ia(l)));
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
            var n = t.memoizedProps, i = n.id, f = n.onPostCommit;
            typeof f == "function" && f(
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
        ) : mu(l, t) : n._visibility & 2 ? xt(
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
        )), u & 2048 && qc(i, t);
        break;
      case 24:
        xt(
          l,
          t,
          e,
          a
        ), u & 2048 && Bc(t.alternate, t);
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
          ), ou(8, i);
          break;
        case 23:
          break;
        case 22:
          var p = i.stateNode;
          i.memoizedState !== null ? p._visibility & 2 ? Aa(
            n,
            i,
            f,
            s,
            u
          ) : mu(
            n,
            i
          ) : (p._visibility |= 2, Aa(
            n,
            i,
            f,
            s,
            u
          )), u && y & 2048 && qc(
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
          ), u && y & 2048 && Bc(i.alternate, i);
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
        go(
          l,
          t,
          e
        ), l = l.sibling;
  }
  function go(l, t, e) {
    switch (l.tag) {
      case 26:
        za(
          l,
          t,
          e
        ), l.flags & hu && l.memoizedState !== null && av(
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
        Et = Yn(l.stateNode.containerInfo), za(
          l,
          t,
          e
        ), Et = a;
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
        for (var e = 0; e < t.length; e++) {
          var a = t[e];
          Rl = a, po(
            a,
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
          Rl = a, po(
            a,
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
  function po(l, t) {
    for (; Rl !== null; ) {
      var e = Rl;
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
      if (a = e.child, a !== null) a.return = e, Rl = a;
      else
        l: for (e = l; Rl !== null; ) {
          a = Rl;
          var u = a.sibling, n = a.return;
          if (so(a), a === e) {
            Rl = null;
            break l;
          }
          if (u !== null) {
            u.return = n, Rl = u;
            break l;
          }
          Rl = n;
        }
    }
  }
  var Sh = {
    getCacheForType: function(l) {
      var t = ql(Nl), e = t.data.get(l);
      return e === void 0 && (e = l(), t.data.set(l, e)), e;
    },
    cacheSignal: function() {
      return ql(Nl).controller.signal;
    }
  }, bh = typeof WeakMap == "function" ? WeakMap : Map, nl = 0, vl = null, $ = null, F = 0, fl = 0, ct = null, he = !1, Ta = !1, Yc = !1, Ft = 0, jl = 0, ve = 0, Je = 0, Gc = 0, ft = 0, Ea = 0, yu = null, Il = null, Qc = !1, xn = 0, jo = 0, Nn = 1 / 0, _n = null, ye = null, Dl = 0, ge = null, xa = null, It = 0, Xc = 0, Lc = null, Ao = null, gu = 0, Zc = null;
  function st() {
    return (nl & 2) !== 0 && F !== 0 ? F & -F : A.T !== null ? Wc() : Bf();
  }
  function zo() {
    if (ft === 0)
      if ((F & 536870912) === 0 || tl) {
        var l = Hu;
        Hu <<= 1, (Hu & 3932160) === 0 && (Hu = 262144), ft = l;
      } else ft = 536870912;
    return l = nt.current, l !== null && (l.flags |= 32), ft;
  }
  function Pl(l, t, e) {
    (l === vl && (fl === 2 || fl === 9) || l.cancelPendingCommit !== null) && (Na(l, 0), Se(
      l,
      F,
      ft,
      !1
    )), Ya(l, e), ((nl & 2) === 0 || l !== vl) && (l === vl && ((nl & 2) === 0 && (Je |= e), jl === 4 && Se(
      l,
      F,
      ft,
      !1
    )), Rt(l));
  }
  function To(l, t, e) {
    if ((nl & 6) !== 0) throw Error(o(327));
    var a = !e && (t & 127) === 0 && (t & l.expiredLanes) === 0 || Ba(l, t), u = a ? Ah(l, t) : Kc(l, t, !0), n = a;
    do {
      if (u === 0) {
        Ta && !a && Se(l, t, 0, !1);
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
              var f = l;
              u = yu;
              var s = f.current.memoizedState.isDehydrated;
              if (s && (Na(f, i).flags |= 256), i = Kc(
                f,
                i,
                !1
              ), i !== 2) {
                if (Yc && !s) {
                  f.errorRecoveryDisabledLanes |= n, Je |= n, u = 4;
                  break l;
                }
                n = Il, Il = u, n !== null && (Il === null ? Il = n : Il.push.apply(
                  Il,
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
                ft,
                !he
              );
              break l;
            case 2:
              Il = null;
              break;
            case 3:
            case 5:
              break;
            default:
              throw Error(o(329));
          }
          if ((t & 62914560) === t && (u = xn + 300 - lt(), 10 < u)) {
            if (Se(
              a,
              t,
              ft,
              !he
            ), Bu(a, 0, !0) !== 0) break l;
            It = t, a.timeoutHandle = tr(
              Eo.bind(
                null,
                a,
                e,
                Il,
                _n,
                Qc,
                t,
                ft,
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
          Eo(
            a,
            e,
            Il,
            _n,
            Qc,
            t,
            ft,
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
    Rt(l);
  }
  function Eo(l, t, e, a, u, n, i, f, s, y, p, T, g, S) {
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
      }, go(
        t,
        n,
        T
      );
      var C = (n & 62914560) === n ? xn - lt() : (n & 4194048) === n ? jo - lt() : 0;
      if (C = uv(
        T,
        C
      ), C !== null) {
        It = n, l.cancelPendingCommit = C(
          Ro.bind(
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
            p,
            T,
            null,
            g,
            S
          )
        ), Se(l, n, i, !y);
        return;
      }
    }
    Ro(
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
  function ph(l) {
    for (var t = l; ; ) {
      var e = t.tag;
      if ((e === 0 || e === 11 || e === 15) && t.flags & 16384 && (e = t.updateQueue, e !== null && (e = e.stores, e !== null)))
        for (var a = 0; a < e.length; a++) {
          var u = e[a], n = u.getSnapshot;
          u = u.value;
          try {
            if (!at(n(), u)) return !1;
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
      var n = 31 - et(u), i = 1 << n;
      a[n] = -1, u &= ~i;
    }
    e !== 0 && Cf(l, e, t);
  }
  function On() {
    return (nl & 6) === 0 ? (Su(0), !1) : !0;
  }
  function Vc() {
    if ($ !== null) {
      if (fl === 0)
        var l = $.return;
      else
        l = $, Xt = Be = null, ic(l), ga = null, lu = 0, l = $;
      for (; l !== null; )
        to(l.alternate, l), l = l.return;
      $ = null;
    }
  }
  function Na(l, t) {
    var e = l.timeoutHandle;
    e !== -1 && (l.timeoutHandle = -1, Qh(e)), e = l.cancelPendingCommit, e !== null && (l.cancelPendingCommit = null, e()), It = 0, Vc(), vl = l, $ = e = Gt(l.current, null), F = t, fl = 0, ct = null, he = !1, Ta = Ba(l, t), Yc = !1, Ea = ft = Gc = Je = ve = jl = 0, Il = yu = null, Qc = !1, (t & 8) !== 0 && (t |= t & 32);
    var a = l.entangledLanes;
    if (a !== 0)
      for (l = l.entanglements, a &= t; 0 < a; ) {
        var u = 31 - et(a), n = 1 << u;
        t |= l[u], a &= ~n;
      }
    return Ft = t, Wu(), e;
  }
  function xo(l, t) {
    K = null, A.H = fu, t === ya || t === an ? (t = Xs(), fl = 3) : t === $i ? (t = Xs(), fl = 4) : fl = t === Ac ? 8 : t !== null && typeof t == "object" && typeof t.then == "function" ? 6 : 1, ct = t, $ === null && (jl = 1, Sn(
      l,
      yt(t, l.current)
    ));
  }
  function No() {
    var l = nt.current;
    return l === null ? !0 : (F & 4194048) === F ? pt === null : (F & 62914560) === F || (F & 536870912) !== 0 ? l === pt : !1;
  }
  function _o() {
    var l = A.H;
    return A.H = fu, l === null ? fu : l;
  }
  function Oo() {
    var l = A.A;
    return A.A = Sh, l;
  }
  function Mn() {
    jl = 4, he || (F & 4194048) !== F && nt.current !== null || (Ta = !0), (ve & 134217727) === 0 && (Je & 134217727) === 0 || vl === null || Se(
      vl,
      F,
      ft,
      !1
    );
  }
  function Kc(l, t, e) {
    var a = nl;
    nl |= 2;
    var u = _o(), n = Oo();
    (vl !== l || F !== t) && (_n = null, Na(l, t)), t = !1;
    var i = jl;
    l: do
      try {
        if (fl !== 0 && $ !== null) {
          var f = $, s = ct;
          switch (fl) {
            case 8:
              Vc(), i = 6;
              break l;
            case 3:
            case 2:
            case 9:
            case 6:
              nt.current === null && (t = !0);
              var y = fl;
              if (fl = 0, ct = null, _a(l, f, s, y), e && Ta) {
                i = 0;
                break l;
              }
              break;
            default:
              y = fl, fl = 0, ct = null, _a(l, f, s, y);
          }
        }
        jh(), i = jl;
        break;
      } catch (p) {
        xo(l, p);
      }
    while (!0);
    return t && l.shellSuspendCounter++, Xt = Be = null, nl = a, A.H = u, A.A = n, $ === null && (vl = null, F = 0, Wu()), i;
  }
  function jh() {
    for (; $ !== null; ) Mo($);
  }
  function Ah(l, t) {
    var e = nl;
    nl |= 2;
    var a = _o(), u = Oo();
    vl !== l || F !== t ? (_n = null, Nn = lt() + 500, Na(l, t)) : Ta = Ba(
      l,
      t
    );
    l: do
      try {
        if (fl !== 0 && $ !== null) {
          t = $;
          var n = ct;
          t: switch (fl) {
            case 1:
              fl = 0, ct = null, _a(l, t, n, 1);
              break;
            case 2:
            case 9:
              if (Gs(n)) {
                fl = 0, ct = null, Do(t);
                break;
              }
              t = function() {
                fl !== 2 && fl !== 9 || vl !== l || (fl = 7), Rt(l);
              }, n.then(t, t);
              break l;
            case 3:
              fl = 7;
              break l;
            case 4:
              fl = 5;
              break l;
            case 7:
              Gs(n) ? (fl = 0, ct = null, Do(t)) : (fl = 0, ct = null, _a(l, t, n, 7));
              break;
            case 5:
              var i = null;
              switch ($.tag) {
                case 26:
                  i = $.memoizedState;
                case 5:
                case 27:
                  var f = $;
                  if (i ? yr(i) : f.stateNode.complete) {
                    fl = 0, ct = null;
                    var s = f.sibling;
                    if (s !== null) $ = s;
                    else {
                      var y = f.return;
                      y !== null ? ($ = y, Dn(y)) : $ = null;
                    }
                    break t;
                  }
              }
              fl = 0, ct = null, _a(l, t, n, 5);
              break;
            case 6:
              fl = 0, ct = null, _a(l, t, n, 6);
              break;
            case 8:
              Vc(), jl = 6;
              break l;
            default:
              throw Error(o(462));
          }
        }
        zh();
        break;
      } catch (p) {
        xo(l, p);
      }
    while (!0);
    return Xt = Be = null, A.H = a, A.A = u, nl = e, $ !== null ? 0 : (vl = null, F = 0, Wu(), jl);
  }
  function zh() {
    for (; $ !== null && !Jr(); )
      Mo($);
  }
  function Mo(l) {
    var t = Pd(l.alternate, l, Ft);
    l.memoizedProps = l.pendingProps, t === null ? Dn(l) : $ = t;
  }
  function Do(l) {
    var t = l, e = t.alternate;
    switch (t.tag) {
      case 15:
      case 0:
        t = wd(
          e,
          t,
          t.pendingProps,
          t.type,
          void 0,
          F
        );
        break;
      case 11:
        t = wd(
          e,
          t,
          t.pendingProps,
          t.type.render,
          t.ref,
          F
        );
        break;
      case 5:
        ic(t);
      default:
        to(e, t), t = $ = _s(t, Ft), t = Pd(e, t, Ft);
    }
    l.memoizedProps = l.pendingProps, t === null ? Dn(l) : $ = t;
  }
  function _a(l, t, e, a) {
    Xt = Be = null, ic(t), ga = null, lu = 0;
    var u = t.return;
    try {
      if (oh(
        l,
        u,
        t,
        e,
        F
      )) {
        jl = 1, Sn(
          l,
          yt(e, l.current)
        ), $ = null;
        return;
      }
    } catch (n) {
      if (u !== null) throw $ = u, n;
      jl = 1, Sn(
        l,
        yt(e, l.current)
      ), $ = null;
      return;
    }
    t.flags & 32768 ? (tl || a === 1 ? l = !0 : Ta || (F & 536870912) !== 0 ? l = !1 : (he = l = !0, (a === 2 || a === 9 || a === 3 || a === 6) && (a = nt.current, a !== null && a.tag === 13 && (a.flags |= 16384))), Uo(t, l)) : Dn(t);
  }
  function Dn(l) {
    var t = l;
    do {
      if ((t.flags & 32768) !== 0) {
        Uo(
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
        $ = e;
        return;
      }
      if (t = t.sibling, t !== null) {
        $ = t;
        return;
      }
      $ = t = l;
    } while (t !== null);
    jl === 0 && (jl = 5);
  }
  function Uo(l, t) {
    do {
      var e = vh(l.alternate, l);
      if (e !== null) {
        e.flags &= 32767, $ = e;
        return;
      }
      if (e = l.return, e !== null && (e.flags |= 32768, e.subtreeFlags = 0, e.deletions = null), !t && (l = l.sibling, l !== null)) {
        $ = l;
        return;
      }
      $ = l = e;
    } while (l !== null);
    jl = 6, $ = null;
  }
  function Ro(l, t, e, a, u, n, i, f, s) {
    l.cancelPendingCommit = null;
    do
      Un();
    while (Dl !== 0);
    if ((nl & 6) !== 0) throw Error(o(327));
    if (t !== null) {
      if (t === l.current) throw Error(o(177));
      if (n = t.lanes | t.childLanes, n |= Ri, em(
        l,
        e,
        n,
        i,
        f,
        s
      ), l === vl && ($ = vl = null, F = 0), xa = t, ge = l, It = e, Xc = n, Lc = u, Ao = a, (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? (l.callbackNode = null, l.callbackPriority = 0, Nh(Ru, function() {
        return Yo(), null;
      })) : (l.callbackNode = null, l.callbackPriority = 0), a = (t.flags & 13878) !== 0, (t.subtreeFlags & 13878) !== 0 || a) {
        a = A.T, A.T = null, u = D.p, D.p = 2, i = nl, nl |= 4;
        try {
          yh(l, t, e);
        } finally {
          nl = i, D.p = u, A.T = a;
        }
      }
      Dl = 1, Co(), Ho(), qo();
    }
  }
  function Co() {
    if (Dl === 1) {
      Dl = 0;
      var l = ge, t = xa, e = (t.flags & 13878) !== 0;
      if ((t.subtreeFlags & 13878) !== 0 || e) {
        e = A.T, A.T = null;
        var a = D.p;
        D.p = 2;
        var u = nl;
        nl |= 4;
        try {
          ho(t, l);
          var n = af, i = bs(l.containerInfo), f = n.focusedElem, s = n.selectionRange;
          if (i !== f && f && f.ownerDocument && Ss(
            f.ownerDocument.documentElement,
            f
          )) {
            if (s !== null && _i(f)) {
              var y = s.start, p = s.end;
              if (p === void 0 && (p = y), "selectionStart" in f)
                f.selectionStart = y, f.selectionEnd = Math.min(
                  p,
                  f.value.length
                );
              else {
                var T = f.ownerDocument || document, g = T && T.defaultView || window;
                if (g.getSelection) {
                  var S = g.getSelection(), C = f.textContent.length, G = Math.min(s.start, C), ml = s.end === void 0 ? G : Math.min(s.end, C);
                  !S.extend && G > ml && (i = ml, ml = G, G = i);
                  var h = gs(
                    f,
                    G
                  ), d = gs(
                    f,
                    ml
                  );
                  if (h && d && (S.rangeCount !== 1 || S.anchorNode !== h.node || S.anchorOffset !== h.offset || S.focusNode !== d.node || S.focusOffset !== d.offset)) {
                    var v = T.createRange();
                    v.setStart(h.node, h.offset), S.removeAllRanges(), G > ml ? (S.addRange(v), S.extend(d.node, d.offset)) : (v.setEnd(d.node, d.offset), S.addRange(v));
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
          Vn = !!ef, af = ef = null;
        } finally {
          nl = u, D.p = a, A.T = e;
        }
      }
      l.current = t, Dl = 2;
    }
  }
  function Ho() {
    if (Dl === 2) {
      Dl = 0;
      var l = ge, t = xa, e = (t.flags & 8772) !== 0;
      if ((t.subtreeFlags & 8772) !== 0 || e) {
        e = A.T, A.T = null;
        var a = D.p;
        D.p = 2;
        var u = nl;
        nl |= 4;
        try {
          fo(l, t.alternate, t);
        } finally {
          nl = u, D.p = a, A.T = e;
        }
      }
      Dl = 3;
    }
  }
  function qo() {
    if (Dl === 4 || Dl === 3) {
      Dl = 0, wr();
      var l = ge, t = xa, e = It, a = Ao;
      (t.subtreeFlags & 10256) !== 0 || (t.flags & 10256) !== 0 ? Dl = 5 : (Dl = 0, xa = ge = null, Bo(l, l.pendingLanes));
      var u = l.pendingLanes;
      if (u === 0 && (ye = null), si(e), t = t.stateNode, tt && typeof tt.onCommitFiberRoot == "function")
        try {
          tt.onCommitFiberRoot(
            qa,
            t,
            void 0,
            (t.current.flags & 128) === 128
          );
        } catch {
        }
      if (a !== null) {
        t = A.T, u = D.p, D.p = 2, A.T = null;
        try {
          for (var n = l.onRecoverableError, i = 0; i < a.length; i++) {
            var f = a[i];
            n(f.value, {
              componentStack: f.stack
            });
          }
        } finally {
          A.T = t, D.p = u;
        }
      }
      (It & 3) !== 0 && Un(), Rt(l), u = l.pendingLanes, (e & 261930) !== 0 && (u & 42) !== 0 ? l === Zc ? gu++ : (gu = 0, Zc = l) : gu = 0, Su(0);
    }
  }
  function Bo(l, t) {
    (l.pooledCacheLanes &= t) === 0 && (t = l.pooledCache, t != null && (l.pooledCache = null, Ia(t)));
  }
  function Un() {
    return Co(), Ho(), qo(), Yo();
  }
  function Yo() {
    if (Dl !== 5) return !1;
    var l = ge, t = Xc;
    Xc = 0;
    var e = si(It), a = A.T, u = D.p;
    try {
      D.p = 32 > e ? 32 : e, A.T = null, e = Lc, Lc = null;
      var n = ge, i = It;
      if (Dl = 0, xa = ge = null, It = 0, (nl & 6) !== 0) throw Error(o(331));
      var f = nl;
      if (nl |= 4, bo(n.current), yo(
        n,
        n.current,
        i,
        e
      ), nl = f, Su(0, !1), tt && typeof tt.onPostCommitFiberRoot == "function")
        try {
          tt.onPostCommitFiberRoot(qa, n);
        } catch {
        }
      return !0;
    } finally {
      D.p = u, A.T = a, Bo(l, t);
    }
  }
  function Go(l, t, e) {
    t = yt(e, t), t = jc(l.stateNode, t, 2), l = de(l, t, 2), l !== null && (Ya(l, 2), Rt(l));
  }
  function sl(l, t, e) {
    if (l.tag === 3)
      Go(l, l, e);
    else
      for (; t !== null; ) {
        if (t.tag === 3) {
          Go(
            t,
            l,
            e
          );
          break;
        } else if (t.tag === 1) {
          var a = t.stateNode;
          if (typeof t.type.getDerivedStateFromError == "function" || typeof a.componentDidCatch == "function" && (ye === null || !ye.has(a))) {
            l = yt(e, l), e = Gd(2), a = de(t, e, 2), a !== null && (Qd(
              e,
              a,
              t,
              l
            ), Ya(a, 2), Rt(a));
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
    u.has(e) || (Yc = !0, u.add(e), l = Th.bind(null, l, t, e), t.then(l, l));
  }
  function Th(l, t, e) {
    var a = l.pingCache;
    a !== null && a.delete(t), l.pingedLanes |= l.suspendedLanes & e, l.warmLanes &= ~e, vl === l && (F & e) === e && (jl === 4 || jl === 3 && (F & 62914560) === F && 300 > lt() - xn ? (nl & 2) === 0 && Na(l, 0) : Gc |= e, Ea === F && (Ea = 0)), Rt(l);
  }
  function Qo(l, t) {
    t === 0 && (t = Rf()), l = Ce(l, t), l !== null && (Ya(l, t), Rt(l));
  }
  function Eh(l) {
    var t = l.memoizedState, e = 0;
    t !== null && (e = t.retryLane), Qo(l, e);
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
        throw Error(o(314));
    }
    a !== null && a.delete(t), Qo(l, e);
  }
  function Nh(l, t) {
    return ni(l, t);
  }
  var Rn = null, Oa = null, wc = !1, Cn = !1, $c = !1, be = 0;
  function Rt(l) {
    l !== Oa && l.next === null && (Oa === null ? Rn = Oa = l : Oa = Oa.next = l), Cn = !0, wc || (wc = !0, Oh());
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
              var i = a.suspendedLanes, f = a.pingedLanes;
              n = (1 << 31 - et(42 | l) + 1) - 1, n &= u & ~(i & ~f), n = n & 201326741 ? n & 201326741 | 1 : n ? n | 2 : 0;
            }
            n !== 0 && (e = !0, Vo(a, n));
          } else
            n = F, n = Bu(
              a,
              a === vl ? n : 0,
              a.cancelPendingCommit !== null || a.timeoutHandle !== -1
            ), (n & 3) === 0 || Ba(a, n) || (e = !0, Vo(a, n));
          a = a.next;
        }
      while (e);
      $c = !1;
    }
  }
  function _h() {
    Xo();
  }
  function Xo() {
    Cn = wc = !1;
    var l = 0;
    be !== 0 && Gh() && (l = be);
    for (var t = lt(), e = null, a = Rn; a !== null; ) {
      var u = a.next, n = Lo(a, t);
      n === 0 ? (a.next = null, e === null ? Rn = u : e.next = u, u === null && (Oa = e)) : (e = a, (l !== 0 || (n & 3) !== 0) && (Cn = !0)), a = u;
    }
    Dl !== 0 && Dl !== 5 || Su(l), be !== 0 && (be = 0);
  }
  function Lo(l, t) {
    for (var e = l.suspendedLanes, a = l.pingedLanes, u = l.expirationTimes, n = l.pendingLanes & -62914561; 0 < n; ) {
      var i = 31 - et(n), f = 1 << i, s = u[i];
      s === -1 ? ((f & e) === 0 || (f & a) !== 0) && (u[i] = tm(f, t)) : s <= t && (l.expiredLanes |= f), n &= ~f;
    }
    if (t = vl, e = F, e = Bu(
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
          e = Df;
          break;
        case 32:
          e = Ru;
          break;
        case 268435456:
          e = Uf;
          break;
        default:
          e = Ru;
      }
      return a = Zo.bind(null, l), e = ni(e, a), l.callbackPriority = t, l.callbackNode = e, t;
    }
    return a !== null && a !== null && ii(a), l.callbackPriority = 2, l.callbackNode = null, 2;
  }
  function Zo(l, t) {
    if (Dl !== 0 && Dl !== 5)
      return l.callbackNode = null, l.callbackPriority = 0, null;
    var e = l.callbackNode;
    if (Un() && l.callbackNode !== e)
      return null;
    var a = F;
    return a = Bu(
      l,
      l === vl ? a : 0,
      l.cancelPendingCommit !== null || l.timeoutHandle !== -1
    ), a === 0 ? null : (To(l, a, t), Lo(l, lt()), l.callbackNode != null && l.callbackNode === e ? Zo.bind(null, l) : null);
  }
  function Vo(l, t) {
    if (Un()) return null;
    To(l, t, !0);
  }
  function Oh() {
    Xh(function() {
      (nl & 6) !== 0 ? ni(
        Mf,
        _h
      ) : Xo();
    });
  }
  function Wc() {
    if (be === 0) {
      var l = ha;
      l === 0 && (l = Cu, Cu <<= 1, (Cu & 261888) === 0 && (Cu = 256)), be = l;
    }
    return be;
  }
  function Ko(l) {
    return l == null || typeof l == "symbol" || typeof l == "boolean" ? null : typeof l == "function" ? l : Xu("" + l);
  }
  function Jo(l, t) {
    var e = t.ownerDocument.createElement("input");
    return e.name = t.name, e.value = t.value, l.id && e.setAttribute("form", l.id), t.parentNode.insertBefore(e, t), l = new FormData(l), e.parentNode.removeChild(e), l;
  }
  function Mh(l, t, e, a, u) {
    if (t === "submit" && e && e.stateNode === u) {
      var n = Ko(
        (u[wl] || null).action
      ), i = a.submitter;
      i && (t = (t = i[wl] || null) ? Ko(t.formAction) : i.getAttribute("formAction"), t !== null && (n = t, i = null));
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
                if (be !== 0) {
                  var s = i ? Jo(u, i) : new FormData(u);
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
                typeof n == "function" && (f.preventDefault(), s = i ? Jo(u, i) : new FormData(u), vc(
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
    Tt(
      Dh,
      "on" + Uh
    );
  }
  Tt(As, "onAnimationEnd"), Tt(zs, "onAnimationIteration"), Tt(Ts, "onAnimationStart"), Tt("dblclick", "onDoubleClick"), Tt("focusin", "onFocus"), Tt("focusout", "onBlur"), Tt($m, "onTransitionRun"), Tt(Wm, "onTransitionStart"), Tt(km, "onTransitionCancel"), Tt(Es, "onTransitionEnd"), la("onMouseEnter", ["mouseout", "mouseover"]), la("onMouseLeave", ["mouseout", "mouseover"]), la("onPointerEnter", ["pointerout", "pointerover"]), la("onPointerLeave", ["pointerout", "pointerover"]), Me(
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
  function wo(l, t) {
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
            } catch (p) {
              $u(p);
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
            } catch (p) {
              $u(p);
            }
            u.currentTarget = null, n = s;
          }
      }
    }
  }
  function W(l, t) {
    var e = t[di];
    e === void 0 && (e = t[di] = /* @__PURE__ */ new Set());
    var a = l + "__bubble";
    e.has(a) || ($o(t, l, 2, !1), e.add(a));
  }
  function Ic(l, t, e) {
    var a = 0;
    t && (a |= 4), $o(
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
        e !== "selectionchange" && (Rh.has(e) || Ic(e, !1, l), Ic(e, !0, l));
      });
      var t = l.nodeType === 9 ? l : l.ownerDocument;
      t === null || t[Hn] || (t[Hn] = !0, Ic("selectionchange", !1, t));
    }
  }
  function $o(l, t, e, a) {
    switch (zr(t)) {
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
    If(function() {
      var y = n, p = gi(e), T = [];
      l: {
        var g = xs.get(l);
        if (g !== void 0) {
          var S = Ku, C = l;
          switch (l) {
            case "keypress":
              if (Zu(e) === 0) break l;
            case "keydown":
            case "keyup":
              S = xm;
              break;
            case "focusin":
              C = "focus", S = zi;
              break;
            case "focusout":
              C = "blur", S = zi;
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
              S = hm;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              S = Om;
              break;
            case As:
            case zs:
            case Ts:
              S = gm;
              break;
            case Es:
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
              S = as;
              break;
            case "toggle":
            case "beforetoggle":
              S = Hm;
          }
          var G = (t & 4) !== 0, ml = !G && (l === "scroll" || l === "scrollend"), h = G ? g !== null ? g + "Capture" : null : g;
          G = [];
          for (var d = y, v; d !== null; ) {
            var z = d;
            if (v = z.stateNode, z = z.tag, z !== 5 && z !== 26 && z !== 27 || v === null || h === null || (z = Xa(d, h), z != null && G.push(
              pu(d, z, v)
            )), ml) break;
            d = d.return;
          }
          0 < G.length && (g = new S(
            g,
            C,
            null,
            e,
            p
          ), T.push({ event: g, listeners: G }));
        }
      }
      if ((t & 7) === 0) {
        l: {
          if (g = l === "mouseover" || l === "pointerover", S = l === "mouseout" || l === "pointerout", g && e !== yi && (C = e.relatedTarget || e.fromElement) && (Fe(C) || C[ke]))
            break l;
          if ((S || g) && (g = p.window === p ? p : (g = p.ownerDocument) ? g.defaultView || g.parentWindow : window, S ? (C = e.relatedTarget || e.toElement, S = y, C = C ? Fe(C) : null, C !== null && (ml = R(C), G = C.tag, C !== ml || G !== 5 && G !== 27 && G !== 6) && (C = null)) : (S = null, C = y), S !== C)) {
            if (G = ts, z = "onMouseLeave", h = "onMouseEnter", d = "mouse", (l === "pointerout" || l === "pointerover") && (G = as, z = "onPointerLeave", h = "onPointerEnter", d = "pointer"), ml = S == null ? g : Qa(S), v = C == null ? g : Qa(C), g = new G(
              z,
              d + "leave",
              S,
              e,
              p
            ), g.target = ml, g.relatedTarget = v, z = null, Fe(p) === y && (G = new G(
              h,
              d + "enter",
              C,
              e,
              p
            ), G.target = v, G.relatedTarget = ml, z = G), ml = z, S && C)
              t: {
                for (G = Ch, h = S, d = C, v = 0, z = h; z; z = G(z))
                  v++;
                z = 0;
                for (var Y = d; Y; Y = G(Y))
                  z++;
                for (; 0 < v - z; )
                  h = G(h), v--;
                for (; 0 < z - v; )
                  d = G(d), z--;
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
              T,
              g,
              S,
              G,
              !1
            ), C !== null && ml !== null && Wo(
              T,
              ml,
              C,
              G,
              !0
            );
          }
        }
        l: {
          if (g = y ? Qa(y) : window, S = g.nodeName && g.nodeName.toLowerCase(), S === "select" || S === "input" && g.type === "file")
            var el = os;
          else if (ss(g))
            if (rs)
              el = Km;
            else {
              el = Zm;
              var B = Lm;
            }
          else
            S = g.nodeName, !S || S.toLowerCase() !== "input" || g.type !== "checkbox" && g.type !== "radio" ? y && vi(y.elementType) && (el = os) : el = Vm;
          if (el && (el = el(l, y))) {
            ds(
              T,
              el,
              e,
              p
            );
            break l;
          }
          B && B(l, g, y), l === "focusout" && y && g.type === "number" && y.memoizedProps.value != null && hi(g, "number", g.value);
        }
        switch (B = y ? Qa(y) : window, l) {
          case "focusin":
            (ss(B) || B.contentEditable === "true") && (ia = B, Oi = y, Wa = null);
            break;
          case "focusout":
            Wa = Oi = ia = null;
            break;
          case "mousedown":
            Mi = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            Mi = !1, ps(T, e, p);
            break;
          case "selectionchange":
            if (wm) break;
          case "keydown":
          case "keyup":
            ps(T, e, p);
        }
        var J;
        if (Ei)
          l: {
            switch (l) {
              case "compositionstart":
                var I = "onCompositionStart";
                break l;
              case "compositionend":
                I = "onCompositionEnd";
                break l;
              case "compositionupdate":
                I = "onCompositionUpdate";
                break l;
            }
            I = void 0;
          }
        else
          na ? cs(l, e) && (I = "onCompositionEnd") : l === "keydown" && e.keyCode === 229 && (I = "onCompositionStart");
        I && (us && e.locale !== "ko" && (na || I !== "onCompositionStart" ? I === "onCompositionEnd" && na && (J = Pf()) : (ae = p, pi = "value" in ae ? ae.value : ae.textContent, na = !0)), B = qn(y, I), 0 < B.length && (I = new es(
          I,
          l,
          null,
          e,
          p
        ), T.push({ event: I, listeners: B }), J ? I.data = J : (J = fs(e), J !== null && (I.data = J)))), (J = Bm ? Ym(l, e) : Gm(l, e)) && (I = qn(y, "onBeforeInput"), 0 < I.length && (B = new es(
          "onBeforeInput",
          "beforeinput",
          null,
          e,
          p
        ), T.push({
          event: B,
          listeners: I
        }), B.data = J)), Mh(
          T,
          l,
          y,
          e,
          p
        );
      }
      wo(T, t);
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
  function Wo(l, t, e, a, u) {
    for (var n = t._reactName, i = []; e !== null && e !== a; ) {
      var f = e, s = f.alternate, y = f.stateNode;
      if (f = f.tag, s !== null && s === a) break;
      f !== 5 && f !== 26 && f !== 27 || y === null || (s = y, u ? (y = Xa(e, n), y != null && i.unshift(
        pu(e, y, s)
      )) : u || (y = Xa(e, n), y != null && i.push(
        pu(e, y, s)
      ))), e = e.return;
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
        kf(l, a, n);
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
        a != null && W("scroll", l);
        break;
      case "onScrollEnd":
        a != null && W("scrollend", l);
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
        W("beforetoggle", l), W("toggle", l), Yu(l, "popover", a);
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
        (!(2 < e.length) || e[0] !== "o" && e[0] !== "O" || e[1] !== "n" && e[1] !== "N") && (e = dm.get(e) || e, Yu(l, e, a));
    }
  }
  function tf(l, t, e, a, u, n) {
    switch (e) {
      case "style":
        kf(l, a, n);
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
        a != null && W("scroll", l);
        break;
      case "onScrollEnd":
        a != null && W("scrollend", l);
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
            if (e[0] === "o" && e[1] === "n" && (u = e.endsWith("Capture"), t = e.slice(2, u ? e.length - 7 : void 0), n = l[wl] || null, n = n != null ? n[e] : null, typeof n == "function" && l.removeEventListener(t, n, u), typeof a == "function")) {
              typeof n != "function" && n !== null && (e in l ? l[e] = null : l.hasAttribute(e) && l.removeAttribute(e)), l.addEventListener(t, a, u);
              break l;
            }
            e in l ? l[e] = a : a === !0 ? l.setAttribute(e, "") : Yu(l, e, a);
          }
    }
  }
  function Yl(l, t, e) {
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
                  rl(l, t, n, i, e, null);
              }
          }
        u && rl(l, t, "srcSet", e.srcSet, e, null), a && rl(l, t, "src", e.src, e, null);
        return;
      case "input":
        W("invalid", l);
        var f = n = i = u = null, s = null, y = null;
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
                  y = p;
                  break;
                case "value":
                  n = p;
                  break;
                case "defaultValue":
                  f = p;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  if (p != null)
                    throw Error(o(137, t));
                  break;
                default:
                  rl(l, t, a, p, e, null);
              }
          }
        Jf(
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
        W("invalid", l), a = i = n = null;
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
        W("invalid", l), n = u = a = null;
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
                rl(l, t, i, f, e, null);
            }
        $f(l, a, u, n);
        return;
      case "option":
        for (s in e)
          e.hasOwnProperty(s) && (a = e[s], a != null) && (s === "selected" ? l.selected = a && typeof a != "function" && typeof a != "symbol" : rl(l, t, s, a, e, null));
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
        for (a = 0; a < bu.length; a++)
          W(bu[a], l);
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
        for (y in e)
          if (e.hasOwnProperty(y) && (a = e[y], a != null))
            switch (y) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(o(137, t));
              default:
                rl(l, t, y, a, e, null);
            }
        return;
      default:
        if (vi(t)) {
          for (p in e)
            e.hasOwnProperty(p) && (a = e[p], a !== void 0 && tf(
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
    for (f in e)
      e.hasOwnProperty(f) && (a = e[f], a != null && rl(l, t, f, a, e, null));
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
        var u = null, n = null, i = null, f = null, s = null, y = null, p = null;
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
                a.hasOwnProperty(S) || rl(l, t, S, null, a, T);
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
                p = S;
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
                S !== T && rl(
                  l,
                  t,
                  g,
                  S,
                  a,
                  T
                );
            }
        }
        mi(
          l,
          i,
          f,
          s,
          y,
          p,
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
                f = n;
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
                if (u != null) throw Error(o(91));
                break;
              default:
                u !== n && rl(l, t, i, u, a, n);
            }
        wf(l, g, S);
        return;
      case "option":
        for (var C in e)
          g = e[C], e.hasOwnProperty(C) && g != null && !a.hasOwnProperty(C) && (C === "selected" ? l.selected = !1 : rl(
            l,
            t,
            C,
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
        for (var G in e)
          g = e[G], e.hasOwnProperty(G) && g != null && !a.hasOwnProperty(G) && rl(l, t, G, null, a, g);
        for (y in a)
          if (g = a[y], S = e[y], a.hasOwnProperty(y) && g !== S && (g != null || S != null))
            switch (y) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (g != null)
                  throw Error(o(137, t));
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
          for (p in a)
            g = a[p], S = e[p], !a.hasOwnProperty(p) || g === S || g === void 0 && S === void 0 || tf(
              l,
              t,
              p,
              g,
              a,
              S
            );
          return;
        }
    }
    for (var h in e)
      g = e[h], e.hasOwnProperty(h) && g != null && !a.hasOwnProperty(h) && rl(l, t, h, null, a, g);
    for (T in a)
      g = a[T], S = e[T], !a.hasOwnProperty(T) || g === S || g == null && S == null || rl(l, t, T, g, a, S);
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
      for (var l = 0, t = 0, e = performance.getEntriesByType("resource"), a = 0; a < e.length; a++) {
        var u = e[a], n = u.transferSize, i = u.initiatorType, f = u.duration;
        if (n && f && Io(i)) {
          for (i = 0, f = u.responseEnd, a += 1; a < e.length; a++) {
            var s = e[a], y = s.startTime;
            if (y > f) break;
            var p = s.transferSize, T = s.initiatorType;
            p && Io(T) && (s = s.responseEnd, i += p * (s < f ? 1 : (f - y) / (s - y)));
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
  function uf(l, t) {
    return l === "textarea" || l === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.children == "bigint" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
  }
  var nf = null;
  function Gh() {
    var l = window.event;
    return l && l.type === "popstate" ? l === nf ? !1 : (nf = l, !0) : (nf = null, !1);
  }
  var tr = typeof setTimeout == "function" ? setTimeout : void 0, Qh = typeof clearTimeout == "function" ? clearTimeout : void 0, er = typeof Promise == "function" ? Promise : void 0, Xh = typeof queueMicrotask == "function" ? queueMicrotask : typeof er < "u" ? function(l) {
    return er.resolve(null).then(l).catch(Lh);
  } : tr;
  function Lh(l) {
    setTimeout(function() {
      throw l;
    });
  }
  function pe(l) {
    return l === "head";
  }
  function ar(l, t) {
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
          ju(l.ownerDocument.documentElement);
        else if (e === "head") {
          e = l.ownerDocument.head, ju(e);
          for (var n = e.firstChild; n; ) {
            var i = n.nextSibling, f = n.nodeName;
            n[Ga] || f === "SCRIPT" || f === "STYLE" || f === "LINK" && n.rel.toLowerCase() === "stylesheet" || e.removeChild(n), n = i;
          }
        } else
          e === "body" && ju(l.ownerDocument.body);
      e = u;
    } while (e);
    Ra(t);
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
  function cf(l) {
    var t = l.firstChild;
    for (t && t.nodeType === 10 && (t = t.nextSibling); t; ) {
      var e = t;
      switch (t = t.nextSibling, e.nodeName) {
        case "HTML":
        case "HEAD":
        case "BODY":
          cf(e), oi(e);
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
      if (l = jt(l.nextSibling), l === null) break;
    }
    return null;
  }
  function Vh(l, t, e) {
    if (t === "") return null;
    for (; l.nodeType !== 3; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !e || (l = jt(l.nextSibling), l === null)) return null;
    return l;
  }
  function nr(l, t) {
    for (; l.nodeType !== 8; )
      if ((l.nodeType !== 1 || l.nodeName !== "INPUT" || l.type !== "hidden") && !t || (l = jt(l.nextSibling), l === null)) return null;
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
  function ir(l) {
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
    switch (t = Bn(e), l) {
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
  function ju(l) {
    for (var t = l.attributes; t.length; )
      l.removeAttributeNode(t[0]);
    oi(l);
  }
  var At = /* @__PURE__ */ new Map(), sr = /* @__PURE__ */ new Set();
  function Yn(l) {
    return typeof l.getRootNode == "function" ? l.getRootNode() : l.nodeType === 9 ? l : l.ownerDocument;
  }
  var Pt = D.d;
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
    var l = Pt.f(), t = On();
    return l || t;
  }
  function wh(l) {
    var t = Ie(l);
    t !== null && t.tag === 5 && t.type === "form" ? Ed(t) : Pt.r(l);
  }
  var Ma = typeof document > "u" ? null : document;
  function dr(l, t, e) {
    var a = Ma;
    if (a && typeof t == "string" && t) {
      var u = ht(t);
      u = 'link[rel="' + l + '"][href="' + u + '"]', typeof e == "string" && (u += '[crossorigin="' + e + '"]'), sr.has(u) || (sr.add(u), l = { rel: l, crossOrigin: e, href: t }, a.querySelector(u) === null && (t = a.createElement("link"), Yl(t, "link", l), Ul(t), a.head.appendChild(t)));
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
      At.has(n) || (l = j(
        {
          rel: "preload",
          href: t === "image" && e && e.imageSrcSet ? void 0 : l,
          as: t
        },
        e
      ), At.set(n, l), a.querySelector(u) !== null || t === "style" && a.querySelector(Au(n)) || t === "script" && a.querySelector(zu(n)) || (t = a.createElement("link"), Yl(t, "link", l), Ul(t), a.head.appendChild(t)));
    }
  }
  function Fh(l, t) {
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
      if (!At.has(n) && (l = j({ rel: "modulepreload", href: l }, t), At.set(n, l), e.querySelector(u) === null)) {
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
        a = e.createElement("link"), Yl(a, "link", l), Ul(a), e.head.appendChild(a);
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
        var f = { loading: 0, preload: null };
        if (i = a.querySelector(
          Au(n)
        ))
          f.loading = 5;
        else {
          l = j(
            { rel: "stylesheet", href: l, "data-precedence": t },
            e
          ), (e = At.get(n)) && of(l, e);
          var s = i = a.createElement("link");
          Ul(s), Yl(s, "link", l), s._p = new Promise(function(y, p) {
            s.onload = y, s.onerror = p;
          }), s.addEventListener("load", function() {
            f.loading |= 1;
          }), s.addEventListener("error", function() {
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
  function Ph(l, t) {
    Pt.X(l, t);
    var e = Ma;
    if (e && l) {
      var a = Pe(e).hoistableScripts, u = Ua(l), n = a.get(u);
      n || (n = e.querySelector(zu(u)), n || (l = j({ src: l, async: !0 }, t), (t = At.get(u)) && rf(l, t), n = e.createElement("script"), Ul(n), Yl(n, "link", l), e.head.appendChild(n)), n = {
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
      n || (n = e.querySelector(zu(u)), n || (l = j({ src: l, async: !0, type: "module" }, t), (t = At.get(u)) && rf(l, t), n = e.createElement("script"), Ul(n), Yl(n, "link", l), e.head.appendChild(n)), n = {
        type: "script",
        instance: n,
        count: 1,
        state: null
      }, a.set(u, n));
    }
  }
  function or(l, t, e, a) {
    var u = (u = w.current) ? Yn(u) : null;
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
            Au(l)
          )) && !n._p && (i.instance = n, i.state.loading = 5), At.has(l) || (e = {
            rel: "preload",
            as: "style",
            href: e.href,
            crossOrigin: e.crossOrigin,
            integrity: e.integrity,
            media: e.media,
            hrefLang: e.hrefLang,
            referrerPolicy: e.referrerPolicy
          }, At.set(l, e), n || tv(
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
  function Au(l) {
    return 'link[rel="stylesheet"][' + l + "]";
  }
  function rr(l) {
    return j({}, l, {
      "data-precedence": l.precedence,
      precedence: null
    });
  }
  function tv(l, t, e, a) {
    l.querySelector('link[rel="preload"][as="style"][' + t + "]") ? a.loading = 1 : (t = l.createElement("link"), a.preload = t, t.addEventListener("load", function() {
      return a.loading |= 1;
    }), t.addEventListener("error", function() {
      return a.loading |= 2;
    }), Yl(t, "link", e), Ul(t), l.head.appendChild(t));
  }
  function Ua(l) {
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
            return t.instance = a, Ul(a), a;
          var u = j({}, e, {
            "data-href": e.href,
            "data-precedence": e.precedence,
            href: null,
            precedence: null
          });
          return a = (l.ownerDocument || l).createElement(
            "style"
          ), Ul(a), Yl(a, "style", u), Gn(a, e.precedence, l), t.instance = a;
        case "stylesheet":
          u = Da(e.href);
          var n = l.querySelector(
            Au(u)
          );
          if (n)
            return t.state.loading |= 4, t.instance = n, Ul(n), n;
          a = rr(e), (u = At.get(u)) && of(a, u), n = (l.ownerDocument || l).createElement("link"), Ul(n);
          var i = n;
          return i._p = new Promise(function(f, s) {
            i.onload = f, i.onerror = s;
          }), Yl(n, "link", a), t.state.loading |= 4, Gn(n, e.precedence, l), t.instance = n;
        case "script":
          return n = Ua(e.src), (u = l.querySelector(
            zu(n)
          )) ? (t.instance = u, Ul(u), u) : (a = e, (u = At.get(n)) && (a = j({}, e), rf(a, u)), l = l.ownerDocument || l, u = l.createElement("script"), Ul(u), Yl(u, "link", a), l.head.appendChild(u), t.instance = u);
        case "void":
          return null;
        default:
          throw Error(o(443, t.type));
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
  function of(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.title == null && (l.title = t.title);
  }
  function rf(l, t) {
    l.crossOrigin == null && (l.crossOrigin = t.crossOrigin), l.referrerPolicy == null && (l.referrerPolicy = t.referrerPolicy), l.integrity == null && (l.integrity = t.integrity);
  }
  var Qn = null;
  function hr(l, t, e) {
    if (Qn === null) {
      var a = /* @__PURE__ */ new Map(), u = Qn = /* @__PURE__ */ new Map();
      u.set(e, a);
    } else
      u = Qn, a = u.get(e), a || (a = /* @__PURE__ */ new Map(), u.set(e, a));
    if (a.has(l)) return a;
    for (a.set(l, null), e = e.getElementsByTagName(l), u = 0; u < e.length; u++) {
      var n = e[u];
      if (!(n[Ga] || n[Cl] || l === "link" && n.getAttribute("rel") === "stylesheet") && n.namespaceURI !== "http://www.w3.org/2000/svg") {
        var i = n.getAttribute(t) || "";
        i = l + i;
        var f = a.get(i);
        f ? f.push(n) : a.set(i, [n]);
      }
    }
    return a;
  }
  function vr(l, t, e) {
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
  function yr(l) {
    return !(l.type === "stylesheet" && (l.state.loading & 3) === 0);
  }
  function av(l, t, e, a) {
    if (e.type === "stylesheet" && (typeof a.media != "string" || matchMedia(a.media).matches !== !1) && (e.state.loading & 4) === 0) {
      if (e.instance === null) {
        var u = Da(a.href), n = t.querySelector(
          Au(u)
        );
        if (n) {
          t = n._p, t !== null && typeof t == "object" && typeof t.then == "function" && (l.count++, l = Xn.bind(l), t.then(l, l)), e.state.loading |= 4, e.instance = n, Ul(n);
          return;
        }
        n = t.ownerDocument || t, a = rr(a), (u = At.get(u)) && of(a, u), n = n.createElement("link"), Ul(n);
        var i = n;
        i._p = new Promise(function(f, s) {
          i.onload = f, i.onerror = s;
        }), Yl(n, "link", a), e.instance = n;
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
  var Ln = null;
  function Zn(l, t) {
    l.stylesheets = null, l.unsuspend !== null && (l.count++, Ln = /* @__PURE__ */ new Map(), t.forEach(nv, l), Ln = null, Xn.call(l));
  }
  function nv(l, t) {
    if (!(t.state.loading & 4)) {
      var e = Ln.get(l);
      if (e) var a = e.get(null);
      else {
        e = /* @__PURE__ */ new Map(), Ln.set(l, e);
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
  var Tu = {
    $$typeof: Gl,
    Provider: null,
    Consumer: null,
    _currentValue: Q,
    _currentValue2: Q,
    _threadCount: 0
  };
  function iv(l, t, e, a, u, n, i, f, s) {
    this.tag = 1, this.containerInfo = l, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = ci(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = ci(0), this.hiddenUpdates = ci(null), this.identifierPrefix = a, this.onUncaughtError = u, this.onCaughtError = n, this.onRecoverableError = i, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = s, this.incompleteTransitions = /* @__PURE__ */ new Map();
  }
  function gr(l, t, e, a, u, n, i, f, s, y, p, T) {
    return l = new iv(
      l,
      t,
      e,
      i,
      s,
      y,
      p,
      T,
      f
    ), t = 1, n === !0 && (t |= 24), n = ut(3, null, null, t), l.current = n, n.stateNode = l, t = Ki(), t.refCount++, l.pooledCache = t, t.refCount++, n.memoizedState = {
      element: a,
      isDehydrated: e,
      cache: t
    }, Wi(n), l;
  }
  function Sr(l) {
    return l ? (l = sa, l) : sa;
  }
  function br(l, t, e, a, u, n) {
    u = Sr(u), a.context === null ? a.context = u : a.pendingContext = u, a = se(t), a.payload = { element: e }, n = n === void 0 ? null : n, n !== null && (a.callback = n), e = de(l, a, t), e !== null && (Pl(e, l, t), eu(e, l, t));
  }
  function pr(l, t) {
    if (l = l.memoizedState, l !== null && l.dehydrated !== null) {
      var e = l.retryLane;
      l.retryLane = e !== 0 && e < t ? e : t;
    }
  }
  function hf(l, t) {
    pr(l, t), (l = l.alternate) && pr(l, t);
  }
  function jr(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = Ce(l, 67108864);
      t !== null && Pl(t, l, 67108864), hf(l, 67108864);
    }
  }
  function Ar(l) {
    if (l.tag === 13 || l.tag === 31) {
      var t = st();
      t = fi(t);
      var e = Ce(l, t);
      e !== null && Pl(e, l, t), hf(l, t);
    }
  }
  var Vn = !0;
  function cv(l, t, e, a) {
    var u = A.T;
    A.T = null;
    var n = D.p;
    try {
      D.p = 2, vf(l, t, e, a);
    } finally {
      D.p = n, A.T = u;
    }
  }
  function fv(l, t, e, a) {
    var u = A.T;
    A.T = null;
    var n = D.p;
    try {
      D.p = 8, vf(l, t, e, a);
    } finally {
      D.p = n, A.T = u;
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
        ), Tr(l, a);
      else if (dv(
        u,
        l,
        t,
        e,
        a
      ))
        a.stopPropagation();
      else if (Tr(l, a), t & 4 && -1 < sv.indexOf(l)) {
        for (; u !== null; ) {
          var n = Ie(u);
          if (n !== null)
            switch (n.tag) {
              case 3:
                if (n = n.stateNode, n.current.memoizedState.isDehydrated) {
                  var i = Oe(n.pendingLanes);
                  if (i !== 0) {
                    var f = n;
                    for (f.pendingLanes |= 2, f.entangledLanes |= 2; i; ) {
                      var s = 1 << 31 - et(i);
                      f.entanglements[1] |= s, i &= ~s;
                    }
                    Rt(n), (nl & 6) === 0 && (Nn = lt() + 500, Su(0));
                  }
                }
                break;
              case 31:
              case 13:
                f = Ce(n, 2), f !== null && Pl(f, n, 2), On(), hf(n, 2);
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
      var t = R(l);
      if (t === null) l = null;
      else {
        var e = t.tag;
        if (e === 13) {
          if (l = X(t), l !== null) return l;
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
  function zr(l) {
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
          case Mf:
            return 2;
          case Df:
            return 8;
          case Ru:
          case Wr:
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
  var Sf = !1, je = null, Ae = null, ze = null, Eu = /* @__PURE__ */ new Map(), xu = /* @__PURE__ */ new Map(), Te = [], sv = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
    " "
  );
  function Tr(l, t) {
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
    }, t !== null && (t = Ie(t), t !== null && jr(t)), l) : (l.eventSystemFlags |= a, t = l.targetContainers, u !== null && t.indexOf(u) === -1 && t.push(u), l);
  }
  function dv(l, t, e, a, u) {
    switch (t) {
      case "focusin":
        return je = Nu(
          je,
          l,
          t,
          e,
          a,
          u
        ), !0;
      case "dragenter":
        return Ae = Nu(
          Ae,
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
  function Er(l) {
    var t = Fe(l.target);
    if (t !== null) {
      var e = R(t);
      if (e !== null) {
        if (t = e.tag, t === 13) {
          if (t = X(e), t !== null) {
            l.blockedOn = t, Yf(l.priority, function() {
              Ar(e);
            });
            return;
          }
        } else if (t === 31) {
          if (t = Z(e), t !== null) {
            l.blockedOn = t, Yf(l.priority, function() {
              Ar(e);
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
  function xr(l, t, e) {
    Jn(l) && e.delete(t);
  }
  function ov() {
    Sf = !1, je !== null && Jn(je) && (je = null), Ae !== null && Jn(Ae) && (Ae = null), ze !== null && Jn(ze) && (ze = null), Eu.forEach(xr), xu.forEach(xr);
  }
  function wn(l, t) {
    l.blockedOn === t && (l.blockedOn = null, Sf || (Sf = !0, m.unstable_scheduleCallback(
      m.unstable_NormalPriority,
      ov
    )));
  }
  var $n = null;
  function Nr(l) {
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
    je !== null && wn(je, l), Ae !== null && wn(Ae, l), ze !== null && wn(ze, l), Eu.forEach(t), xu.forEach(t);
    for (var e = 0; e < Te.length; e++) {
      var a = Te[e];
      a.blockedOn === l && (a.blockedOn = null);
    }
    for (; 0 < Te.length && (e = Te[0], e.blockedOn === null); )
      Er(e), e.blockedOn === null && Te.shift();
    if (e = (l.ownerDocument || l).$$reactFormReplay, e != null)
      for (a = 0; a < e.length; a += 3) {
        var u = e[a], n = e[a + 1], i = u[wl] || null;
        if (typeof n == "function")
          i || Nr(e);
        else if (i) {
          var f = null;
          if (n && n.hasAttribute("formAction")) {
            if (u = n, i = n[wl] || null)
              f = i.formAction;
            else if (gf(u) !== null) continue;
          } else f = i.action;
          typeof f == "function" ? e[a + 1] = f : (e.splice(a, 3), a -= 3), Nr(e);
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
    if (t === null) throw Error(o(409));
    var e = t.current, a = st();
    br(e, a, l, t, null, null);
  }, Wn.prototype.unmount = bf.prototype.unmount = function() {
    var l = this._internalRoot;
    if (l !== null) {
      this._internalRoot = null;
      var t = l.containerInfo;
      br(l.current, 2, null, l, null, null), On(), t[ke] = null;
    }
  };
  function Wn(l) {
    this._internalRoot = l;
  }
  Wn.prototype.unstable_scheduleHydration = function(l) {
    if (l) {
      var t = Bf();
      l = { blockedOn: null, target: l, priority: t };
      for (var e = 0; e < Te.length && t !== 0 && t < Te[e].priority; e++) ;
      Te.splice(e, 0, l), e === 0 && Er(l);
    }
  };
  var Or = x.version;
  if (Or !== "19.2.8")
    throw Error(
      o(
        527,
        Or,
        "19.2.8"
      )
    );
  D.findDOMNode = function(l) {
    var t = l._reactInternals;
    if (t === void 0)
      throw typeof l.render == "function" ? Error(o(188)) : (l = Object.keys(l).join(","), Error(o(268, l)));
    return l = b(t), l = l !== null ? _(l) : null, l = l === null ? null : l.stateNode, l;
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
        ), tt = kn;
      } catch {
      }
  }
  return Ou.createRoot = function(l, t) {
    if (!H(l)) throw Error(o(299));
    var e = !1, a = "", u = Hd, n = qd, i = Bd;
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
      _r
    ), l[ke] = t.current, Pc(l), new bf(t);
  }, Ou.hydrateRoot = function(l, t, e) {
    if (!H(l)) throw Error(o(299));
    var a = !1, u = "", n = Hd, i = qd, f = Bd, s = null;
    return e != null && (e.unstable_strictMode === !0 && (a = !0), e.identifierPrefix !== void 0 && (u = e.identifierPrefix), e.onUncaughtError !== void 0 && (n = e.onUncaughtError), e.onCaughtError !== void 0 && (i = e.onCaughtError), e.onRecoverableError !== void 0 && (f = e.onRecoverableError), e.formState !== void 0 && (s = e.formState)), t = gr(
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
      _r
    ), t.context = Sr(null), e = t.current, a = st(), a = fi(a), u = se(a), u.callback = null, de(e, u, a), e = a, t.current.lanes = e, Ya(t, e), Rt(t), l[ke] = t.current, Pc(l), new Wn(t);
  }, Ou.version = "19.2.8", Ou;
}
var Gr;
function Av() {
  if (Gr) return Af.exports;
  Gr = 1;
  function m() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(m);
      } catch (x) {
        console.error(x);
      }
  }
  return m(), Af.exports = jv(), Af.exports;
}
var zv = Av();
class Tv extends Error {
  constructor(x, M, o) {
    super(x), this.status = M, this.payload = o;
  }
  status;
  payload;
}
async function dt(m, x = {}) {
  const M = new Headers(x.headers);
  x.body && !M.has("content-type") && M.set("content-type", "application/json");
  const o = await fetch(m, { ...x, headers: M, credentials: "same-origin" });
  let H = {};
  try {
    H = await o.json();
  } catch {
  }
  if (!o.ok) {
    const R = H && typeof H == "object" ? H : {}, X = typeof R.error == "string" ? R.error : typeof R.message == "string" ? R.message : `Request failed (${o.status})`;
    throw new Tv(X, o.status, H);
  }
  return H;
}
const ot = {
  commandCenter: () => dt("/api/console/command-center"),
  work: () => dt("/api/console/requirements"),
  automations: () => dt("/api/console/automations"),
  automationSettings: () => dt("/api/console/automation-settings"),
  connector: () => dt("/api/console/connector/status"),
  advanced: () => dt("/api/console/advanced"),
  automationAction: (m, x, M, o) => dt(`/api/console/automations/${encodeURIComponent(m)}/${encodeURIComponent(x)}/${encodeURIComponent(M)}/${encodeURIComponent(o)}`, { method: "POST", body: "{}" }),
  providerAction: (m, x) => dt(`/api/console/providers/${encodeURIComponent(m)}/${x}`, { method: "POST", body: "{}" }),
  providerHealth: (m) => dt("/api/console/providers/health", { method: "POST", body: JSON.stringify({ providerId: m }) }),
  localToolAction: (m, x) => dt(`/api/console/local-tools/${encodeURIComponent(m)}/${x}`, { method: "POST", body: "{}" }),
  localToolHealth: (m) => dt("/api/console/local-tools/health", { method: "POST", body: JSON.stringify({ toolId: m }) }),
  registerRepository: (m, x) => dt("/api/repositories/register", { method: "POST", body: JSON.stringify({ path: m, displayName: x }) }),
  removeRepository: (m) => dt(`/api/repositories/${encodeURIComponent(m)}/remove`, { method: "POST", body: "{}" })
}, Zr = [
  { id: "overview", label: "Overview", group: "daily" },
  { id: "automations", label: "Automations", group: "daily" },
  { id: "work", label: "Work", group: "daily" },
  { id: "capabilities", label: "Capabilities", group: "manage" },
  { id: "repositories", label: "Repositories", group: "manage" },
  { id: "settings", label: "Settings", group: "manage" },
  { id: "system", label: "System", group: "system" }
];
function Qr() {
  const m = location.hash.replace(/^#\/?/, "").split("/")[0];
  return Zr.some((x) => x.id === m) ? m : "overview";
}
function le({ children: m, ...x }) {
  return /* @__PURE__ */ c.jsx("svg", { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: "1.55", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", ...x, children: m });
}
const Ev = (m) => /* @__PURE__ */ c.jsx(le, { ...m, children: /* @__PURE__ */ c.jsx("path", { d: "M3 9.2 10 3l7 6.2v7.1a.7.7 0 0 1-.7.7h-4.2v-5H7.9v5H3.7a.7.7 0 0 1-.7-.7z" }) }), xv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4.2 6.3A6.5 6.5 0 0 1 16 7" }),
  /* @__PURE__ */ c.jsx("path", { d: "m16 3 .4 4.4-4.4.4" }),
  /* @__PURE__ */ c.jsx("path", { d: "M15.8 13.7A6.5 6.5 0 0 1 4 13" }),
  /* @__PURE__ */ c.jsx("path", { d: "m4 17-.4-4.4 4.4-.4" })
] }), Nv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4 5.2h12v10.6H4z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M7 5.2V3.6h6v1.6M7 9h6M7 12h4" })
] }), _v = (m) => /* @__PURE__ */ c.jsx(le, { ...m, children: /* @__PURE__ */ c.jsx("path", { d: "m10 2.8 2 4 4.4.7-3.2 3.1.8 4.4-4-2.1L6 15l.8-4.4-3.2-3.1L8 6.8z" }) }), Ov = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M4 3.5h5l1.4 2H16v11H4z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M4 8h12" })
] }), Mv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("circle", { cx: "10", cy: "10", r: "2.5" }),
  /* @__PURE__ */ c.jsx("path", { d: "M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" })
] }), Dv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M3.2 4.5h13.6v9.2H3.2z" }),
  /* @__PURE__ */ c.jsx("path", { d: "M7 17h6M10 13.7V17" })
] }), Uv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("path", { d: "M15.5 6A6 6 0 1 0 16 12" }),
  /* @__PURE__ */ c.jsx("path", { d: "m15.5 2.8.3 3.7-3.7.2" })
] }), Rv = (m) => /* @__PURE__ */ c.jsxs(le, { ...m, children: [
  /* @__PURE__ */ c.jsx("circle", { cx: "8.8", cy: "8.8", r: "5" }),
  /* @__PURE__ */ c.jsx("path", { d: "m12.5 12.5 4 4" })
] }), Cv = { overview: Ev, automations: xv, work: Nv, capabilities: _v, repositories: Ov, settings: Mv, system: Dv }, Hv = { daily: "Workspace", manage: "Configure", system: "System" };
function qv({ route: m }) {
  let x = "";
  return /* @__PURE__ */ c.jsxs("aside", { className: "sidebar", children: [
    /* @__PURE__ */ c.jsxs("div", { className: "brand", children: [
      /* @__PURE__ */ c.jsx("span", { className: "brand-mark", children: "F" }),
      /* @__PURE__ */ c.jsxs("div", { children: [
        /* @__PURE__ */ c.jsx("strong", { children: "Forge" }),
        /* @__PURE__ */ c.jsx("small", { children: "Utility Console" })
      ] })
    ] }),
    /* @__PURE__ */ c.jsx("nav", { children: Zr.map((M) => {
      const o = Cv[M.id], H = M.group !== x;
      return x = M.group, /* @__PURE__ */ c.jsxs("div", { className: H ? "nav-group-start" : "nav-item", children: [
        H && /* @__PURE__ */ c.jsx("div", { className: "nav-group-label", children: Hv[M.group] }),
        /* @__PURE__ */ c.jsxs("a", { href: `#/${M.id}`, className: m === M.id ? "active" : "", children: [
          /* @__PURE__ */ c.jsx(o, {}),
          /* @__PURE__ */ c.jsx("span", { children: M.label })
        ] })
      ] }, M.id);
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
function Bv({ route: m, children: x }) {
  return /* @__PURE__ */ c.jsxs("div", { className: "app-shell", children: [
    /* @__PURE__ */ c.jsx(qv, { route: m }),
    /* @__PURE__ */ c.jsx("main", { className: "workspace", children: x })
  ] });
}
function we(m) {
  if (!m) return "—";
  const x = new Date(m);
  return Number.isNaN(x.getTime()) ? m : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: !1 }).format(x);
}
function Ct(m, x = 86) {
  const M = (m ?? "").trim();
  return M.length > x ? `${M.slice(0, x - 1)}…` : M;
}
function Ca(m, x = "—") {
  return typeof m == "string" && m.trim() ? m : String(m ?? x);
}
function Pn(m) {
  return JSON.stringify(m ?? {}, null, 2);
}
function $e({ eyebrow: m, title: x, description: M, refreshedAt: o, busy: H, onRefresh: R, actions: X }) {
  return /* @__PURE__ */ c.jsxs("header", { className: "command-bar", children: [
    /* @__PURE__ */ c.jsxs("div", { className: "command-title", children: [
      m && /* @__PURE__ */ c.jsx("div", { className: "eyebrow", children: m }),
      /* @__PURE__ */ c.jsx("h1", { children: x }),
      /* @__PURE__ */ c.jsx("p", { children: M })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "command-actions", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "command-meta", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Last synced" }),
        /* @__PURE__ */ c.jsx("strong", { children: we(o) })
      ] }),
      /* @__PURE__ */ c.jsx("button", { className: "icon-button", onClick: R, disabled: H, title: "Refresh", children: /* @__PURE__ */ c.jsx(Uv, {}) }),
      X,
      /* @__PURE__ */ c.jsx("a", { className: "button ghost-link", href: "https://chatgpt.com", target: "_blank", rel: "noreferrer", children: "Open ChatGPT ↗" })
    ] })
  ] });
}
function Yv(m) {
  const x = (m ?? "").toLowerCase();
  return /ready|enabled|healthy|success|done|completed|active/.test(x) ? "success" : /attention|blocked|error|fail|danger/.test(x) ? "danger" : /pause|waiting|warn|degrad|stale|planned/.test(x) ? "warning" : /info|running/.test(x) ? "info" : "neutral";
}
function Xl({ label: m, tone: x }) {
  const M = x && ["success", "warning", "danger", "info", "neutral"].includes(x) ? x : Yv(x ?? m);
  return /* @__PURE__ */ c.jsxs("span", { className: "status-text", children: [
    /* @__PURE__ */ c.jsx("i", { className: `status-dot ${M}` }),
    m
  ] });
}
function In({ title: m, meta: x, actions: M }) {
  return /* @__PURE__ */ c.jsxs("div", { className: "section-header", children: [
    /* @__PURE__ */ c.jsxs("div", { children: [
      /* @__PURE__ */ c.jsx("h2", { children: m }),
      x && /* @__PURE__ */ c.jsx("span", { children: x })
    ] }),
    M && /* @__PURE__ */ c.jsx("div", { children: M })
  ] });
}
function Xr(m) {
  return `${String(m.title ?? "")}:${String(m.reason ?? "")}`;
}
function Gv({ data: m, busy: x, onRefresh: M }) {
  const o = m.commandCenter, H = m.automations.summary, R = m.work, X = o.pluginSummary ?? {}, Z = o.repositories ?? [], N = o.readiness ?? {}, b = [...o.handoffs ?? []].filter((k, xl, cl) => cl.findIndex((P) => Xr(P) === Xr(k)) === xl), _ = R.waitingForUserCount ?? 0, j = [...b.slice(0, 3), ..._ ? [{ title: "Persistent work needs attention", reason: `${_} 项长期目标需要确认`, statusLabel: "Review", tone: "warning" }] : [], ...X.needsAttention ?? 0 ? [{ title: "Capabilities need attention", reason: `${X.needsAttention} 项能力需要配置或检查`, statusLabel: "Inspect", tone: "warning" }] : []].slice(0, 4), O = (R.requirements ?? []).filter((k) => k.state !== "done" && k.state !== "cancelled").slice(0, 5), ul = String(N.label ?? N.headline ?? "Forge is ready"), El = String(N.explanation ?? N.summary ?? "Controller, runtime and configured capabilities are available.");
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "FORGE CONTROL PLANE", title: "Overview", description: "长期配置与系统可用性。执行结果和通知继续由 ChatGPT 承担。", refreshedAt: m.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ c.jsxs("section", { className: "overview-posture", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "overview-posture-copy", children: [
        /* @__PURE__ */ c.jsx("div", { className: "eyebrow", children: "CURRENT POSTURE" }),
        /* @__PURE__ */ c.jsxs("div", { className: "overview-posture-title", children: [
          /* @__PURE__ */ c.jsx("h2", { children: ul }),
          /* @__PURE__ */ c.jsx(Xl, { label: String(N.state ?? "Ready"), tone: String(N.state ?? "success") })
        ] }),
        /* @__PURE__ */ c.jsx("p", { children: Ct(El, 180) })
      ] }),
      /* @__PURE__ */ c.jsxs("a", { className: `posture-attention ${j.length ? "has-attention" : ""}`, href: "#attention", children: [
        /* @__PURE__ */ c.jsx("span", { children: j.length ? "Needs attention" : "Attention" }),
        /* @__PURE__ */ c.jsx("strong", { children: j.length }),
        /* @__PURE__ */ c.jsx("small", { children: j.length ? "review actionable items →" : "nothing blocking" })
      ] })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "signal-strip", children: [
      /* @__PURE__ */ c.jsxs("a", { href: "#/automations", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Automations" }),
        /* @__PURE__ */ c.jsx("strong", { children: H.enabled }),
        /* @__PURE__ */ c.jsx("small", { children: H.paused ? `${H.paused} paused` : "enabled" })
      ] }),
      /* @__PURE__ */ c.jsxs("a", { href: "#/capabilities", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Capabilities" }),
        /* @__PURE__ */ c.jsxs("strong", { children: [
          X.ready ?? 0,
          /* @__PURE__ */ c.jsxs("i", { children: [
            "/ ",
            X.total ?? (o.plugins ?? []).length
          ] })
        ] }),
        /* @__PURE__ */ c.jsx("small", { children: "ready" })
      ] }),
      /* @__PURE__ */ c.jsxs("a", { href: "#/repositories", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Repositories" }),
        /* @__PURE__ */ c.jsx("strong", { children: Z.length }),
        /* @__PURE__ */ c.jsx("small", { children: "registered" })
      ] }),
      /* @__PURE__ */ c.jsxs("a", { href: "#/work", children: [
        /* @__PURE__ */ c.jsx("span", { children: "Persistent work" }),
        /* @__PURE__ */ c.jsx("strong", { children: R.activeRequirementCount ?? 0 }),
        /* @__PURE__ */ c.jsxs("small", { children: [
          R.waitingForUserCount ?? 0,
          " waiting"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ c.jsxs("section", { className: "page-section attention-section", id: "attention", children: [
      /* @__PURE__ */ c.jsx(In, { title: "Needs attention", meta: j.length ? `${j.length} actionable groups` : "All clear" }),
      j.length ? /* @__PURE__ */ c.jsx("div", { className: "attention-list", children: j.map((k, xl) => /* @__PURE__ */ c.jsxs("div", { className: "attention-row", children: [
        /* @__PURE__ */ c.jsx("span", { className: "attention-index", children: String(xl + 1).padStart(2, "0") }),
        /* @__PURE__ */ c.jsxs("div", { children: [
          /* @__PURE__ */ c.jsx("strong", { children: String(k.title ?? "需要处理") }),
          /* @__PURE__ */ c.jsx("p", { children: Ct(String(k.reason ?? "请在 ChatGPT 中确认"), 120) })
        ] }),
        /* @__PURE__ */ c.jsx(Xl, { label: String(k.statusLabel ?? "Review"), tone: String(k.tone ?? "warning") })
      ] }, `${String(k.title)}-${xl}`)) }) : /* @__PURE__ */ c.jsxs("div", { className: "quiet-empty success-empty", children: [
        /* @__PURE__ */ c.jsx(Xl, { label: ul, tone: String(N.state ?? "success") }),
        /* @__PURE__ */ c.jsx("p", { children: "当前没有需要你在控制台处理的配置问题。" })
      ] })
    ] }),
    /* @__PURE__ */ c.jsxs("section", { className: "page-section", children: [
      /* @__PURE__ */ c.jsx(In, { title: "Configured work", meta: "Persistent goals only" }),
      O.length ? /* @__PURE__ */ c.jsx("div", { className: "compact-work-list", children: O.map((k) => /* @__PURE__ */ c.jsxs("a", { href: "#/work", children: [
        /* @__PURE__ */ c.jsxs("div", { children: [
          /* @__PURE__ */ c.jsx("strong", { children: k.title }),
          /* @__PURE__ */ c.jsx("p", { children: Ct(k.outcome, 100) })
        ] }),
        /* @__PURE__ */ c.jsx(Xl, { label: k.state === "waiting_for_user" ? "Waiting" : k.state === "planned" ? "Planned" : "Active", tone: k.state })
      ] }, k.requirementId)) }) : /* @__PURE__ */ c.jsx("div", { className: "quiet-empty", children: /* @__PURE__ */ c.jsx("p", { children: "当前没有持久化目标。临时执行不会堆积在这里。" }) })
    ] })
  ] });
}
function Nf({ items: m, value: x, onChange: M }) {
  return /* @__PURE__ */ c.jsx("div", { className: "segmented", role: "tablist", children: m.map((o) => /* @__PURE__ */ c.jsxs("button", { role: "tab", "aria-selected": x === o.id, className: x === o.id ? "selected" : "", onClick: () => M(o.id), children: [
    o.label,
    o.count !== void 0 && /* @__PURE__ */ c.jsx("span", { children: o.count })
  ] }, o.id)) });
}
function li({ title: m, subtitle: x, actions: M, children: o, empty: H }) {
  return /* @__PURE__ */ c.jsx("aside", { className: "detail-pane", children: m ? /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsxs("div", { className: "detail-head", children: [
      /* @__PURE__ */ c.jsxs("div", { children: [
        /* @__PURE__ */ c.jsx("div", { className: "eyebrow", children: "DETAIL" }),
        /* @__PURE__ */ c.jsx("h2", { children: m }),
        x && /* @__PURE__ */ c.jsx("p", { children: x })
      ] }),
      M && /* @__PURE__ */ c.jsx("div", { className: "detail-actions", children: M })
    ] }),
    /* @__PURE__ */ c.jsx("div", { className: "detail-body", children: o })
  ] }) : /* @__PURE__ */ c.jsx("div", { className: "detail-empty", children: H ?? "选择一项查看详细配置" }) });
}
function Du({ items: m }) {
  return /* @__PURE__ */ c.jsx("dl", { className: "definition-list", children: m.map(([x, M]) => /* @__PURE__ */ c.jsxs("div", { children: [
    /* @__PURE__ */ c.jsx("dt", { children: x }),
    /* @__PURE__ */ c.jsx("dd", { children: M })
  ] }, x)) });
}
function xe({ children: m, className: x = "", ...M }) {
  return /* @__PURE__ */ c.jsx("button", { className: `button ${x}`.trim(), ...M, children: m });
}
function Qv({ data: m, busy: x, onRefresh: M, onAction: o }) {
  const H = m.automations.automations, [R, X] = bl.useState("enabled"), Z = bl.useMemo(() => H.filter((O) => R === "all" || O.status === R), [H, R]), [N, b] = bl.useState(), _ = (O) => `${O.source}:${O.repoId}:${O.id}`, j = Z.find((O) => _(O) === N) ?? Z[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "LONG-RUNNING CONFIG", title: "Automations", description: "管理 Forge 持久化 Schedule 与 Assistant Routine；结果正文继续发送到 ChatGPT / Email。", refreshedAt: m.automations.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ c.jsx("div", { className: "toolbar", children: /* @__PURE__ */ c.jsx(Nf, { value: R, onChange: X, items: [{ id: "enabled", label: "Enabled", count: H.filter((O) => O.status === "enabled").length }, { id: "paused", label: "Paused", count: H.filter((O) => O.status === "paused").length }, { id: "attention", label: "Attention", count: H.filter((O) => O.status === "attention").length }, { id: "all", label: "All", count: H.length }] }) }),
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
          /* @__PURE__ */ c.jsx("tbody", { children: Z.map((O) => /* @__PURE__ */ c.jsxs("tr", { className: j && _(j) === _(O) ? "selected" : "", onClick: () => b(_(O)), children: [
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx("strong", { children: O.name }),
              /* @__PURE__ */ c.jsxs("small", { children: [
                O.repositoryName,
                " · ",
                O.source
              ] })
            ] }),
            /* @__PURE__ */ c.jsx("td", { children: O.schedule }),
            /* @__PURE__ */ c.jsx("td", { children: O.delivery ?? "—" }),
            /* @__PURE__ */ c.jsx("td", { children: /* @__PURE__ */ c.jsx(Xl, { label: O.status, tone: O.status }) }),
            /* @__PURE__ */ c.jsxs("td", { children: [
              /* @__PURE__ */ c.jsx("span", { children: Ct(O.lastResult, 30) || "—" }),
              /* @__PURE__ */ c.jsx("small", { children: we(O.lastRunAt) })
            ] }),
            /* @__PURE__ */ c.jsx("td", { children: we(O.nextRunHint) })
          ] }, _(O))) })
        ] }),
        !Z.length && /* @__PURE__ */ c.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有 Automation。" })
      ] }),
      /* @__PURE__ */ c.jsx(li, { title: j?.name, subtitle: j?.summary, empty: "选择一个 Automation 查看配置", children: j && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Du, { items: [["Status", /* @__PURE__ */ c.jsx(Xl, { label: j.status, tone: j.status })], ["Schedule", j.schedule], ["Source", j.source], ["Repository", j.repositoryName], ["Delivery", j.delivery ?? "—"], ["Last result", j.lastResult ?? "—"], ["Last run", we(j.lastRunAt)], ["Next", we(j.nextRunHint)]] }),
        j.pausedReason && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Paused reason" }),
          /* @__PURE__ */ c.jsx("p", { children: j.pausedReason })
        ] }),
        /* @__PURE__ */ c.jsx("div", { className: "detail-button-row", children: j.actions.map((O) => /* @__PURE__ */ c.jsx(xe, { disabled: x, className: O === "pause" ? "danger-text" : "", onClick: () => {
          o(j, O);
        }, children: O === "run" ? "Run now" : O === "pause" ? "Pause" : "Resume" }, O)) }),
        /* @__PURE__ */ c.jsx("p", { className: "detail-note", children: "这里只保存调度配置与最近一次结果摘要，不复制日报、SEO 或研究正文。" })
      ] }) })
    ] })
  ] });
}
function Fn(m, x) {
  return x === "all" ? !0 : x === "waiting" ? m.state === "waiting_for_user" : x === "completed" ? m.state === "done" || m.state === "cancelled" : m.state === "active" || m.state === "planned";
}
function Xv({ data: m, busy: x, onRefresh: M }) {
  const o = m.work.requirements ?? [], [H, R] = bl.useState("active"), X = bl.useMemo(() => o.filter((_) => Fn(_, H)), [o, H]), [Z, N] = bl.useState(), b = X.find((_) => _.requirementId === Z) ?? X[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "PERSISTENT GOALS", title: "Work", description: "粗粒度查看长期目标；不展示 Agent 步骤、Run 流水或推测进度。", refreshedAt: m.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ c.jsx("div", { className: "toolbar", children: /* @__PURE__ */ c.jsx(Nf, { value: H, onChange: R, items: [{ id: "active", label: "Open", count: o.filter((_) => Fn(_, "active")).length }, { id: "waiting", label: "Waiting", count: o.filter((_) => Fn(_, "waiting")).length }, { id: "completed", label: "Completed", count: o.filter((_) => Fn(_, "completed")).length }, { id: "all", label: "All", count: o.length }] }) }),
    /* @__PURE__ */ c.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "scan-list", children: [
        X.map((_) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row ${b?.requirementId === _.requirementId ? "selected" : ""}`, onClick: () => N(_.requirementId), children: [
          /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
            /* @__PURE__ */ c.jsx("strong", { children: _.title }),
            /* @__PURE__ */ c.jsx("p", { children: Ct(_.outcome || _.blocker, 96) })
          ] }),
          /* @__PURE__ */ c.jsxs("div", { className: "scan-meta", children: [
            /* @__PURE__ */ c.jsx(Xl, { label: _.state === "waiting_for_user" ? "Waiting" : _.state === "done" ? "Completed" : _.state === "planned" ? "Planned" : "Active", tone: _.state }),
            /* @__PURE__ */ c.jsx("time", { children: we(_.updatedAt) })
          ] })
        ] }, _.requirementId)),
        !X.length && /* @__PURE__ */ c.jsx("div", { className: "quiet-empty", children: "这个筛选条件下没有持久化目标。" })
      ] }),
      /* @__PURE__ */ c.jsx(li, { title: b?.title, subtitle: b?.outcome, empty: "选择一个长期目标查看完整上下文", children: b && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Du, { items: [["State", /* @__PURE__ */ c.jsx(Xl, { label: b.state, tone: b.state })], ["Updated", we(b.updatedAt)], ["Requirement", /* @__PURE__ */ c.jsx("code", { children: b.requirementId })]] }),
        b.blocker && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Blocker" }),
          /* @__PURE__ */ c.jsx("p", { children: b.blocker })
        ] }),
        b.requiredUserDecision && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout danger", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Decision required" }),
          /* @__PURE__ */ c.jsx("p", { children: b.requiredUserDecision })
        ] }),
        /* @__PURE__ */ c.jsx("p", { className: "detail-note", children: "执行步骤、检查证据和 Run 细节不在这里展开；继续工作请回到 ChatGPT。" })
      ] }) })
    ] })
  ] });
}
function Mu(m) {
  const x = `${m.name} ${m.provider} ${(m.capabilityLabels ?? []).join(" ")}`.toLowerCase();
  return /gmail|calendar|github|google task|notion/.test(x) ? "services" : /browser|desktop|ios|repository|codegraph|local/.test(x) ? "execution" : "extensions";
}
function Lv({ data: m, busy: x, onRefresh: M }) {
  const o = m.commandCenter.plugins ?? [], H = m.automationSettings.providers ?? [], [R, X] = bl.useState("all"), [Z, N] = bl.useState(), b = bl.useMemo(() => o.filter((j) => R === "all" || R === "models" || Mu(j) === R), [o, R]), _ = b.find((j) => j.id === Z) ?? b[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "CAPABILITY CATALOG", title: "Capabilities", description: "从“Forge 能做什么”查看扩展、服务、执行能力和模型，而不是浏览 MCP tool 清单。", refreshedAt: m.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ c.jsx("div", { className: "toolbar", children: /* @__PURE__ */ c.jsx(Nf, { value: R, onChange: X, items: [{ id: "all", label: "All", count: o.length }, { id: "extensions", label: "Extensions", count: o.filter((j) => Mu(j) === "extensions").length }, { id: "services", label: "Services", count: o.filter((j) => Mu(j) === "services").length }, { id: "execution", label: "Execution", count: o.filter((j) => Mu(j) === "execution").length }, { id: "models", label: "Models", count: H.length }] }) }),
    R === "models" ? /* @__PURE__ */ c.jsx("div", { className: "single-list", children: /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: H.map((j) => /* @__PURE__ */ c.jsxs("div", { className: "scan-row static", children: [
      /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
        /* @__PURE__ */ c.jsx("strong", { children: j.displayName }),
        /* @__PURE__ */ c.jsx("p", { children: Ct(j.explanation ?? j.summary, 110) })
      ] }),
      /* @__PURE__ */ c.jsx(Xl, { label: j.statusLabel ?? j.status ?? "Unknown", tone: j.status })
    ] }, j.providerId)) }) }) : /* @__PURE__ */ c.jsxs("div", { className: "split-workspace", children: [
      /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: b.map((j) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row ${_?.id === j.id ? "selected" : ""}`, onClick: () => N(j.id), children: [
        /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ c.jsx("span", { className: "row-eyebrow", children: Mu(j).toUpperCase() }),
          /* @__PURE__ */ c.jsx("strong", { children: j.name }),
          /* @__PURE__ */ c.jsx("p", { children: Ct(j.description, 100) })
        ] }),
        /* @__PURE__ */ c.jsx(Xl, { label: j.statusLabel ?? j.status ?? "Unknown", tone: j.status ?? j.tone })
      ] }, j.id)) }),
      /* @__PURE__ */ c.jsx(li, { title: _?.name, subtitle: _?.description, children: _ && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Du, { items: [["Status", /* @__PURE__ */ c.jsx(Xl, { label: _.statusLabel ?? _.status ?? "Unknown", tone: _.status ?? _.tone })], ["Provider", _.provider ?? "—"], ["Health", _.healthLabel ?? "—"], ["Lifecycle", _.lifecycleLabel ?? "—"]] }),
        _.nextStep && /* @__PURE__ */ c.jsxs("div", { className: "detail-callout warning", children: [
          /* @__PURE__ */ c.jsx("strong", { children: "Next step" }),
          /* @__PURE__ */ c.jsx("p", { children: _.nextStep })
        ] }),
        (_.capabilityLabels ?? []).length > 0 && /* @__PURE__ */ c.jsx("div", { className: "capability-lines", children: _.capabilityLabels.map((j) => /* @__PURE__ */ c.jsx("span", { children: j }, j)) }),
        (_.warnings ?? []).map((j) => /* @__PURE__ */ c.jsx("div", { className: "detail-callout warning", children: j }, j)),
        /* @__PURE__ */ c.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced · actions & protocol" }),
          /* @__PURE__ */ c.jsx("pre", { children: Pn({ actions: _.actions, advanced: _.advanced }) })
        ] })
      ] }) })
    ] })
  ] });
}
function Zv({ value: m, onChange: x, placeholder: M = "Search…" }) {
  return /* @__PURE__ */ c.jsxs("label", { className: "search-field", children: [
    /* @__PURE__ */ c.jsx(Rv, {}),
    /* @__PURE__ */ c.jsx("input", { value: m, onChange: (o) => x(o.target.value), placeholder: M })
  ] });
}
function Vv({ data: m, busy: x, onRefresh: M, onRegister: o, onRemove: H }) {
  const R = m.commandCenter.repositories ?? [], [X, Z] = bl.useState(""), [N, b] = bl.useState(), [_, j] = bl.useState(""), [O, ul] = bl.useState(""), [El, k] = bl.useState(!1), xl = bl.useMemo(() => R.filter((P) => `${P.name} ${P.path} ${P.branchLabel}`.toLowerCase().includes(X.toLowerCase())), [R, X]), cl = xl.find((P) => P.id === N) ?? xl[0];
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "CONTROLLER REGISTRY", title: "Repositories", description: "查看和管理 Forge 的持久化仓库边界；临时目录不需要出现在这里。", refreshedAt: m.generatedAt, busy: x, onRefresh: M, actions: /* @__PURE__ */ c.jsx(xe, { onClick: () => k((P) => !P), "aria-expanded": El, children: El ? "Cancel" : "Add repository" }) }),
    /* @__PURE__ */ c.jsxs("div", { className: "repository-tools", children: [
      /* @__PURE__ */ c.jsx(Zv, { value: X, onChange: Z, placeholder: "Search repositories…" }),
      /* @__PURE__ */ c.jsx("span", { className: "repository-count", children: xl.length === R.length ? `${R.length} registered` : `${xl.length} of ${R.length}` })
    ] }),
    El && /* @__PURE__ */ c.jsxs("form", { className: "repository-add-panel", onSubmit: (P) => {
      P.preventDefault(), _.trim() && o(_.trim(), O.trim() || void 0).then(() => {
        j(""), ul(""), k(!1);
      });
    }, children: [
      /* @__PURE__ */ c.jsxs("div", { className: "repository-add-fields", children: [
        /* @__PURE__ */ c.jsxs("label", { children: [
          /* @__PURE__ */ c.jsx("span", { children: "Local path" }),
          /* @__PURE__ */ c.jsx("input", { autoFocus: !0, value: _, onChange: (P) => j(P.target.value), placeholder: "/absolute/path" })
        ] }),
        /* @__PURE__ */ c.jsxs("label", { children: [
          /* @__PURE__ */ c.jsx("span", { children: "Display name" }),
          /* @__PURE__ */ c.jsx("input", { value: O, onChange: (P) => ul(P.target.value), placeholder: "Optional" })
        ] }),
        /* @__PURE__ */ c.jsx(xe, { type: "submit", disabled: x || !_.trim(), children: "Register" })
      ] }),
      /* @__PURE__ */ c.jsx("p", { children: "只为需要持久化 Work、缓存、并发隔离或发布治理的仓库建立注册项。" })
    ] }),
    /* @__PURE__ */ c.jsxs("div", { className: "split-workspace repository-workspace", children: [
      /* @__PURE__ */ c.jsx("div", { className: "scan-list", children: xl.map((P) => /* @__PURE__ */ c.jsxs("button", { className: `scan-row ${cl?.id === P.id ? "selected" : ""}`, onClick: () => b(P.id), children: [
        /* @__PURE__ */ c.jsxs("div", { className: "scan-main", children: [
          /* @__PURE__ */ c.jsx("strong", { children: P.name }),
          /* @__PURE__ */ c.jsx("p", { children: Ct(P.path, 100) })
        ] }),
        /* @__PURE__ */ c.jsxs("div", { className: "scan-meta", children: [
          /* @__PURE__ */ c.jsx(Xl, { label: P.readinessLabel ?? P.statusLabel ?? "Registered", tone: P.readinessLabel ?? P.statusLabel }),
          /* @__PURE__ */ c.jsx("span", { children: P.branchLabel ?? "—" })
        ] })
      ] }, P.id)) }),
      /* @__PURE__ */ c.jsx(li, { title: cl?.name, subtitle: cl?.path, children: cl && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
        /* @__PURE__ */ c.jsx(Du, { items: [["Repository id", /* @__PURE__ */ c.jsx("code", { children: cl.id })], ["Branch", cl.branchLabel ?? "—"], ["Working tree", cl.dirtyLabel ?? "—"], ["Readiness", /* @__PURE__ */ c.jsx(Xl, { label: cl.readinessLabel ?? cl.statusLabel ?? "Registered", tone: cl.readinessLabel ?? cl.statusLabel })]] }),
        /* @__PURE__ */ c.jsxs("details", { className: "advanced", children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced registry metadata" }),
          /* @__PURE__ */ c.jsx("pre", { children: Pn(cl.advanced) })
        ] }),
        /* @__PURE__ */ c.jsx("div", { className: "detail-button-row", children: /* @__PURE__ */ c.jsx(xe, { className: "danger-text", disabled: x, onClick: () => {
          H(cl.id);
        }, children: "Remove registry entry" }) })
      ] }) })
    ] })
  ] });
}
function Kv({ data: m, busy: x, onRefresh: M, onProviderAction: o, onProviderHealth: H, onToolAction: R, onToolHealth: X }) {
  const Z = m.automationSettings;
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "LONG-LIVED CONFIG", title: "Settings", description: "模型、Provider 与本地工具的长期默认配置。Automation 调度不在这里。", refreshedAt: m.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ c.jsxs("div", { className: "settings-column", children: [
      (Z.warnings ?? []).map((N) => /* @__PURE__ */ c.jsx("div", { className: "detail-callout warning", children: N }, N)),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx(In, { title: "Models & routing", meta: `${Z.providers?.length ?? 0} providers` }),
        /* @__PURE__ */ c.jsx("div", { className: "settings-list", children: (Z.providers ?? []).map((N) => /* @__PURE__ */ c.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("strong", { children: N.displayName }),
            /* @__PURE__ */ c.jsx("p", { children: Ct(N.explanation ?? N.summary, 120) })
          ] }),
          /* @__PURE__ */ c.jsx(Xl, { label: N.statusLabel ?? N.status ?? "Unknown", tone: N.status }),
          /* @__PURE__ */ c.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ c.jsx(xe, { disabled: x, onClick: () => {
              H(N);
            }, children: "Check" }),
            /* @__PURE__ */ c.jsx(xe, { disabled: x, onClick: () => {
              o(N, N.enabled === !1 ? "enable" : "disable");
            }, children: N.enabled === !1 ? "Enable" : "Disable" })
          ] })
        ] }, N.providerId)) })
      ] }),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx(In, { title: "Local tools", meta: `${Z.localTools?.length ?? 0} configured` }),
        /* @__PURE__ */ c.jsx("div", { className: "settings-list", children: (Z.localTools ?? []).map((N) => /* @__PURE__ */ c.jsxs("div", { className: "settings-row", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("strong", { children: N.displayName }),
            /* @__PURE__ */ c.jsx("p", { children: Ct(N.summary, 120) })
          ] }),
          /* @__PURE__ */ c.jsx(Xl, { label: N.status ?? (N.enabled === !1 ? "Disabled" : "Configured"), tone: N.status }),
          /* @__PURE__ */ c.jsxs("div", { className: "settings-actions", children: [
            /* @__PURE__ */ c.jsx(xe, { disabled: x, onClick: () => {
              X(N);
            }, children: "Check" }),
            /* @__PURE__ */ c.jsx(xe, { disabled: x, onClick: () => {
              R(N, N.enabled === !1 ? "enable" : "disable");
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
function Jv({ data: m, busy: x, onRefresh: M }) {
  const [o, H] = bl.useState(), R = m.commandCenter.readiness ?? {};
  return /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
    /* @__PURE__ */ c.jsx($e, { eyebrow: "MAINTENANCE", title: "System", description: "低频工程维护入口。正常使用 Forge 不需要理解这里的运行时细节。", refreshedAt: m.generatedAt, busy: x, onRefresh: M }),
    /* @__PURE__ */ c.jsxs("div", { className: "system-layout", children: [
      /* @__PURE__ */ c.jsxs("section", { className: "system-summary", children: [
        /* @__PURE__ */ c.jsxs("div", { className: "system-posture", children: [
          /* @__PURE__ */ c.jsxs("div", { children: [
            /* @__PURE__ */ c.jsx("span", { className: "eyebrow", children: "SYSTEM POSTURE" }),
            /* @__PURE__ */ c.jsx("h2", { children: Ca(R.label ?? R.headline, "Controller state") }),
            /* @__PURE__ */ c.jsx("p", { children: Ca(R.explanation ?? R.summary, "Controller and connector status") })
          ] }),
          /* @__PURE__ */ c.jsx(Xl, { label: Ca(R.state, "Unknown"), tone: Ca(R.state) })
        ] }),
        /* @__PURE__ */ c.jsx(Du, { items: [["Controller", Ca(R.label ?? R.headline, "—")], ["Connector", Ca(m.connector?.status, "—")], ["Repositories", String(m.commandCenter.repositories?.length ?? 0)], ["Plugins", String(m.commandCenter.plugins?.length ?? 0)]] })
      ] }),
      /* @__PURE__ */ c.jsxs("section", { children: [
        /* @__PURE__ */ c.jsx("button", { className: "text-button", onClick: () => {
          ot.advanced().then(H);
        }, children: "Load advanced diagnostics" }),
        o && /* @__PURE__ */ c.jsxs("details", { className: "advanced", open: !0, children: [
          /* @__PURE__ */ c.jsx("summary", { children: "Advanced diagnostics" }),
          /* @__PURE__ */ c.jsx("pre", { children: Pn(o) })
        ] })
      ] })
    ] })
  ] });
}
async function Lr() {
  const [m, x, M, o, H] = await Promise.all([ot.commandCenter(), ot.work(), ot.automations(), ot.automationSettings(), ot.connector().catch(() => {
  })]);
  return { commandCenter: m, work: x, automations: M, automationSettings: o, connector: H, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function wv() {
  const [m, x] = bl.useState(Qr()), [M, o] = bl.useState(), [H, R] = bl.useState(!1), [X, Z] = bl.useState(""), N = bl.useCallback(async () => {
    R(!0), Z("");
    try {
      o(await Lr());
    } catch (O) {
      Z(O instanceof Error ? O.message : String(O));
    } finally {
      R(!1);
    }
  }, []);
  bl.useEffect(() => {
    N();
    const O = () => x(Qr());
    return addEventListener("hashchange", O), () => removeEventListener("hashchange", O);
  }, [N]);
  const b = bl.useCallback(async (O) => {
    R(!0);
    try {
      await O(), o(await Lr());
    } catch (ul) {
      Z(ul instanceof Error ? ul.message : String(ul));
    } finally {
      R(!1);
    }
  }, []);
  if (!M) return /* @__PURE__ */ c.jsxs("div", { className: "boot-state", children: [
    /* @__PURE__ */ c.jsx("span", { className: "brand-mark", children: "F" }),
    /* @__PURE__ */ c.jsx("strong", { children: X ? "Forge console unavailable" : "Loading Forge…" }),
    X && /* @__PURE__ */ c.jsxs(c.Fragment, { children: [
      /* @__PURE__ */ c.jsx("p", { children: X }),
      /* @__PURE__ */ c.jsx("button", { className: "button", onClick: () => {
        N();
      }, children: "Retry" })
    ] })
  ] });
  const _ = { data: M, busy: H, onRefresh: () => {
    N();
  } };
  let j;
  switch (m) {
    case "automations":
      j = /* @__PURE__ */ c.jsx(Qv, { ..._, onAction: (O, ul) => b(() => ot.automationAction(O.source, O.repoId, O.id, ul)) });
      break;
    case "work":
      j = /* @__PURE__ */ c.jsx(Xv, { ..._ });
      break;
    case "capabilities":
      j = /* @__PURE__ */ c.jsx(Lv, { ..._ });
      break;
    case "repositories":
      j = /* @__PURE__ */ c.jsx(Vv, { ..._, onRegister: (O, ul) => b(() => ot.registerRepository(O, ul)), onRemove: (O) => b(() => ot.removeRepository(O)) });
      break;
    case "settings":
      j = /* @__PURE__ */ c.jsx(Kv, { ..._, onProviderAction: (O, ul) => b(() => ot.providerAction(O.providerId, ul)), onProviderHealth: (O) => b(() => ot.providerHealth(O.providerId)), onToolAction: (O, ul) => b(() => ot.localToolAction(O.toolId, ul)), onToolHealth: (O) => b(() => ot.localToolHealth(O.toolId)) });
      break;
    case "system":
      j = /* @__PURE__ */ c.jsx(Jv, { ..._ });
      break;
    default:
      j = /* @__PURE__ */ c.jsx(Gv, { ..._ });
  }
  return /* @__PURE__ */ c.jsxs(Bv, { route: m, children: [
    X && /* @__PURE__ */ c.jsxs("div", { className: "global-error", children: [
      /* @__PURE__ */ c.jsx("strong", { children: "Last action failed" }),
      /* @__PURE__ */ c.jsx("span", { children: X }),
      /* @__PURE__ */ c.jsx("button", { onClick: () => Z(""), children: "×" })
    ] }),
    j
  ] });
}
const Vr = document.getElementById("app");
if (!Vr) throw new Error("Forge console root missing");
zv.createRoot(Vr).render(/* @__PURE__ */ c.jsx(bl.StrictMode, { children: /* @__PURE__ */ c.jsx(wv, {}) }));
