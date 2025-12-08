import type { Agent } from '../core/agent.js';

// ============================================================================
// Routing Pattern - Dynamic routing and decision making
// ============================================================================

export interface Route {
  /** Route identifier */
  id: string;
  /** Route name */
  name: string;
  /** Description of when to use this route */
  description: string;
  /** Handler function for this route */
  handler: (input: string, context?: Record<string, unknown>) => Promise<string>;
  /** Keywords that trigger this route */
  keywords?: string[];
  /** Priority (higher = more preferred, default: 0) */
  priority?: number;
  /** Whether this route is enabled */
  enabled?: boolean;
}

export interface RoutingDecision {
  /** Selected route */
  route: Route;
  /** Confidence score (0-1) */
  confidence: number;
  /** Reason for selection */
  reason: string;
  /** Alternative routes considered */
  alternatives: Array<{ route: Route; confidence: number }>;
}

export interface RouterConfig {
  /** Default route when no match found */
  defaultRoute?: Route;
  /** Minimum confidence threshold for route selection (default: 0.3) */
  confidenceThreshold: number;
  /** Use LLM for intelligent routing (default: true) */
  useLLMRouting: boolean;
  /** Custom routing prompt */
  routingPrompt?: string;
}

export interface RoutingResult {
  /** The input that was routed */
  input: string;
  /** The routing decision */
  decision: RoutingDecision;
  /** The output from the selected route handler */
  output: string;
  /** Execution time in ms */
  executionTimeMs: number;
}

const DEFAULT_ROUTING_PROMPT = `You are a routing assistant. Analyze the user input and select the most appropriate route.

User Input: {input}

Available Routes:
{routes}

Select the best route and explain why. Output your decision in JSON format:
{
  "routeId": "<id of selected route>",
  "confidence": <number between 0 and 1>,
  "reason": "<brief explanation>"
}

Only output the JSON, no other text.`;

/**
 * Router class - implements dynamic routing
 */
export class Router {
  private routes: Map<string, Route> = new Map();
  private config: RouterConfig;

  constructor(config?: Partial<RouterConfig>) {
    this.config = {
      confidenceThreshold: config?.confidenceThreshold ?? 0.3,
      useLLMRouting: config?.useLLMRouting ?? true,
      defaultRoute: config?.defaultRoute,
      routingPrompt: config?.routingPrompt,
    };
  }

  /**
   * Add a route
   */
  addRoute(route: Route): this {
    this.routes.set(route.id, { ...route, enabled: route.enabled ?? true });
    return this;
  }

  /**
   * Add multiple routes
   */
  addRoutes(routes: Route[]): this {
    for (const route of routes) {
      this.addRoute(route);
    }
    return this;
  }

  /**
   * Remove a route
   */
  removeRoute(id: string): boolean {
    return this.routes.delete(id);
  }

  /**
   * Enable/disable a route
   */
  setRouteEnabled(id: string, enabled: boolean): boolean {
    const route = this.routes.get(id);
    if (route) {
      route.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * Get all routes
   */
  getRoutes(): Route[] {
    return Array.from(this.routes.values());
  }

  /**
   * Get enabled routes
   */
  getEnabledRoutes(): Route[] {
    return this.getRoutes().filter((r) => r.enabled);
  }

  /**
   * Route using keyword matching (fast, no LLM)
   */
  routeByKeywords(input: string): RoutingDecision | null {
    const inputLower = input.toLowerCase();
    const enabledRoutes = this.getEnabledRoutes();
    const scores: Array<{ route: Route; score: number }> = [];

    for (const route of enabledRoutes) {
      if (!route.keywords || route.keywords.length === 0) continue;

      let matchCount = 0;
      for (const keyword of route.keywords) {
        if (inputLower.includes(keyword.toLowerCase())) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        const score = matchCount / route.keywords.length;
        scores.push({ route, score });
      }
    }

    if (scores.length === 0) return null;

    // Sort by score and priority
    scores.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return (b.route.priority ?? 0) - (a.route.priority ?? 0);
    });

    const best = scores[0];
    const alternatives = scores.slice(1, 4).map((s) => ({
      route: s.route,
      confidence: s.score,
    }));

    return {
      route: best.route,
      confidence: best.score,
      reason: `Matched ${Math.round(best.score * 100)}% of keywords`,
      alternatives,
    };
  }

  /**
   * Route using LLM (intelligent, requires agent)
   */
  async routeByLLM(agent: Agent, input: string): Promise<RoutingDecision | null> {
    const enabledRoutes = this.getEnabledRoutes();
    if (enabledRoutes.length === 0) return null;

    const routesDescription = enabledRoutes
      .map((r) => `- ID: ${r.id}, Name: ${r.name}, Description: ${r.description}`)
      .join('\n');

    const prompt = (this.config.routingPrompt || DEFAULT_ROUTING_PROMPT)
      .replace('{input}', input)
      .replace('{routes}', routesDescription);

    const result = await agent.run(prompt);

    try {
      const jsonMatch = result.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const selectedRoute = this.routes.get(parsed.routeId);

        if (selectedRoute) {
          return {
            route: selectedRoute,
            confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
            reason: parsed.reason || 'Selected by LLM',
            alternatives: [],
          };
        }
      }
    } catch {
      // Fall through to keyword routing
    }

    return null;
  }

  /**
   * Route input to appropriate handler
   */
  async route(
    input: string,
    options?: {
      agent?: Agent;
      context?: Record<string, unknown>;
      forceKeywordRouting?: boolean;
    }
  ): Promise<RoutingResult> {
    const startTime = Date.now();

    let decision: RoutingDecision | null = null;

    // Try keyword routing first (fast)
    decision = this.routeByKeywords(input);

    // If no keyword match and LLM routing is enabled, try LLM
    if (
      !decision &&
      this.config.useLLMRouting &&
      options?.agent &&
      !options?.forceKeywordRouting
    ) {
      decision = await this.routeByLLM(options.agent, input);
    }

    // Fall back to default route
    if (!decision || decision.confidence < this.config.confidenceThreshold) {
      if (this.config.defaultRoute) {
        decision = {
          route: this.config.defaultRoute,
          confidence: 1,
          reason: 'Using default route',
          alternatives: decision ? [{ route: decision.route, confidence: decision.confidence }] : [],
        };
      } else {
        throw new Error('No matching route found and no default route configured');
      }
    }

    // Execute the selected route handler
    const output = await decision.route.handler(input, options?.context);

    return {
      input,
      decision,
      output,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Create a simple route from a function
   */
  static createRoute(
    id: string,
    name: string,
    description: string,
    handler: (input: string) => Promise<string>,
    options?: { keywords?: string[]; priority?: number }
  ): Route {
    return {
      id,
      name,
      description,
      handler,
      keywords: options?.keywords,
      priority: options?.priority ?? 0,
      enabled: true,
    };
  }
}

/**
 * Create a router instance
 */
export function createRouter(config?: Partial<RouterConfig>): Router {
  return new Router(config);
}

/**
 * Create a route with agent handler
 */
export function createAgentRoute(
  id: string,
  name: string,
  description: string,
  agent: Agent,
  systemPromptOverride?: string
): Route {
  return {
    id,
    name,
    description,
    handler: async (input: string) => {
      const result = await agent.run(input);
      return result.response;
    },
    enabled: true,
  };
}
