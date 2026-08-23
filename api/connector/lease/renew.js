import { handleRenewLease } from "../../_lib/handlers.js";
import { connectorRoute } from "../../_lib/route.js";

export default connectorRoute(handleRenewLease);
