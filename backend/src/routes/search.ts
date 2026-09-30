import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { SearchIndexService } from "../services/search/searchIndexService.js";
import type { SearchIndexRepairService } from "../services/search/searchIndexRepairService.js";
import type { PrincipalResolver } from "../middleware/rbac.js";
import { ROLE_PERMISSIONS } from "../../../lib/rbac.js";
import { ok } from "../responses.js";

const searchQuerySchema = z.object({
  q: z.string().optional(),
  type: z.enum(["vault", "saved_pool", "quest", "settlement"]).optional(),
  asset: z.string().optional(),
  network: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
  include_unlisted: z.coerce.boolean().optional(),
});

export const searchRoutes = (
  searchService: SearchIndexService,
  repairService: SearchIndexRepairService,
  resolvers: PrincipalResolver[] = [],
  repairGuard?: preHandlerHookHandler,
): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/search", async (req) => {
      let principal = req.principal;
      if (!principal && resolvers.length > 0) {
        for (const resolver of resolvers) {
          const resolved = await resolver(req);
          if (resolved) {
            principal = resolved;
            break;
          }
        }
      }

      const q = searchQuerySchema.parse(req.query);

      const context = principal
        ? {
            walletAddress: principal.walletAddress,
            roles: [principal.role],
            permissions: ROLE_PERMISSIONS[principal.role] || [],
          }
        : undefined;

      const result = await searchService.search(
        {
          q: q.q,
          recordType: q.type,
          asset: q.asset,
          network: q.network,
          status: q.status,
          limit: q.limit,
          offset: q.offset,
          includeUnlisted: q.include_unlisted,
        },
        context,
      );

      return ok(result);
    });

    const repairPreHandlers = repairGuard ? [repairGuard] : [];
    app.post(
      "/api/search/repair",
      { preHandler: repairPreHandlers },
      async () => {
        const report = await repairService.runRepair();
        return ok(report);
      },
    );

    app.get("/api/search/stats", async () => {
      const stats = await searchService.getStats();
      return ok(stats);
    });
  };
