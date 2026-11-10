// Simulated Next.js build output that would previously be scanned and
// manufacture false env/api findings.
!(function () {
  var env = { NEXT_PUBLIC_BUILD_SECRET: "stale-bundled-value" };
  var res = fetch("/api/nonexistent", { method: "GET" });
  res.then(function (r) {
    return r.json();
  });
  self.__NEXT_CHUNK_FLAGS__ = { dense: true, px: process.env.NEXT_PUBLIC_BUILD_SECRET };
})();
