/**
 * webapp/feature_routes.ts: routes for features beyond the core (rates,
 * reports, AI input, Telegram linking, admin). Registered into the one route
 * table so the handler file stays small.
 */
import { addRoutes } from "./api_routes";

addRoutes({});
