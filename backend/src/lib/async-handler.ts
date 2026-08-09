import type { NextFunction, Request, Response } from 'express';

// Every route in this app uses only named params (:companyId, :id), which are
// always plain strings at runtime — but the installed @types/express (v5)
// types req.params as `string | string[]` by default (ParamsDictionary
// accounts for wildcard route segments this app never uses). Pinning the
// generic here, in the one shared wrapper every route handler goes through,
// fixes every route's `req.params.x` type without touching 12 files.
type AppRequest = Request<Record<string, string>>;

export type AsyncRouteHandler = (
  req: AppRequest,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

export function asyncHandler(handler: AsyncRouteHandler) {
  return function wrapped(req: AppRequest, res: Response, next: NextFunction) {
    void handler(req, res, next).catch(next);
  };
}
