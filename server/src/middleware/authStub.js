/**
 * PLACEHOLDER AUTH — Slice 3 replaces this with real JWT auth + admin/viewer RBAC.
 *
 * Currently lets every dashboard-API request through with a synthetic admin
 * identity so the audit endpoints are exercisable end-to-end. Do NOT ship to
 * production with this middleware in place.
 */
export function authStub(req, _res, next) {
  req.user = { id: 0, email: 'stub-admin', role: 'admin', stub: true };
  next();
}
