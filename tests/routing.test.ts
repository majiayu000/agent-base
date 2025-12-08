import { describe, it, expect, beforeEach } from 'bun:test';
import { Router, createRouter } from '../src/patterns/routing.js';
import type { Route } from '../src/patterns/routing.js';

describe('Routing Pattern', () => {
  let router: Router;

  const createTestRoute = (id: string, keywords: string[] = []): Route => ({
    id,
    name: `Route ${id}`,
    description: `Test route ${id}`,
    handler: async (input) => `Handled by ${id}: ${input}`,
    keywords,
    priority: 0,
    enabled: true,
  });

  beforeEach(() => {
    router = createRouter();
  });

  describe('createRouter', () => {
    it('should create router with default config', () => {
      const r = createRouter();
      expect(r).toBeInstanceOf(Router);
    });

    it('should create router with custom config', () => {
      const r = createRouter({
        confidenceThreshold: 0.5,
        useLLMRouting: false,
      });
      expect(r).toBeInstanceOf(Router);
    });
  });

  describe('addRoute()', () => {
    it('should add a route', () => {
      const route = createTestRoute('test1');
      router.addRoute(route);
      expect(router.getRoutes()).toHaveLength(1);
    });

    it('should support chaining', () => {
      const result = router
        .addRoute(createTestRoute('test1'))
        .addRoute(createTestRoute('test2'));
      expect(result).toBe(router);
      expect(router.getRoutes()).toHaveLength(2);
    });
  });

  describe('addRoutes()', () => {
    it('should add multiple routes', () => {
      router.addRoutes([
        createTestRoute('test1'),
        createTestRoute('test2'),
        createTestRoute('test3'),
      ]);
      expect(router.getRoutes()).toHaveLength(3);
    });
  });

  describe('removeRoute()', () => {
    it('should remove a route', () => {
      router.addRoute(createTestRoute('test1'));
      const removed = router.removeRoute('test1');
      expect(removed).toBe(true);
      expect(router.getRoutes()).toHaveLength(0);
    });

    it('should return false for non-existent route', () => {
      const removed = router.removeRoute('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('setRouteEnabled()', () => {
    it('should enable/disable a route', () => {
      router.addRoute(createTestRoute('test1'));
      router.setRouteEnabled('test1', false);
      expect(router.getEnabledRoutes()).toHaveLength(0);

      router.setRouteEnabled('test1', true);
      expect(router.getEnabledRoutes()).toHaveLength(1);
    });
  });

  describe('routeByKeywords()', () => {
    beforeEach(() => {
      router.addRoutes([
        createTestRoute('weather', ['weather', 'temperature', 'forecast']),
        createTestRoute('math', ['calculate', 'math', 'number']),
        createTestRoute('search', ['search', 'find', 'look up']),
      ]);
    });

    it('should route based on keywords', () => {
      const decision = router.routeByKeywords('What is the weather today?');
      expect(decision).not.toBeNull();
      expect(decision?.route.id).toBe('weather');
    });

    it('should return null when no keywords match', () => {
      const decision = router.routeByKeywords('Hello world');
      expect(decision).toBeNull();
    });

    it('should calculate confidence based on keyword matches', () => {
      const decision = router.routeByKeywords('calculate the temperature');
      expect(decision).not.toBeNull();
      // Should match 'calculate' from math route
      expect(decision?.confidence).toBeGreaterThan(0);
    });

    it('should include alternatives in decision', () => {
      // Input that could match multiple routes
      router.addRoute(createTestRoute('alt', ['weather']));
      const decision = router.routeByKeywords('check weather forecast');
      expect(decision?.alternatives).toBeDefined();
    });
  });

  describe('route()', () => {
    beforeEach(() => {
      router.addRoute({
        id: 'default',
        name: 'Default',
        description: 'Default handler',
        handler: async (input) => `Default: ${input}`,
        enabled: true,
      });
      router.addRoute(createTestRoute('greeting', ['hello', 'hi', 'hey']));
    });

    it('should route and execute handler', async () => {
      const result = await router.route('hello there', { forceKeywordRouting: true });
      expect(result.output).toContain('greeting');
      expect(result.decision.route.id).toBe('greeting');
    });

    it('should use default route when no match', async () => {
      const r = createRouter({
        defaultRoute: {
          id: 'fallback',
          name: 'Fallback',
          description: 'Fallback route',
          handler: async () => 'Fallback response',
          enabled: true,
        },
      });
      r.addRoute(createTestRoute('specific', ['specific-keyword']));

      const result = await r.route('random input', { forceKeywordRouting: true });
      expect(result.decision.route.id).toBe('fallback');
    });

    it('should track execution time', async () => {
      const result = await router.route('hello', { forceKeywordRouting: true });
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Router.createRoute()', () => {
    it('should create a route with defaults', () => {
      const route = Router.createRoute(
        'test',
        'Test Route',
        'A test route',
        async (input) => `Output: ${input}`
      );
      expect(route.id).toBe('test');
      expect(route.enabled).toBe(true);
      expect(route.priority).toBe(0);
    });

    it('should create a route with options', () => {
      const route = Router.createRoute(
        'test',
        'Test Route',
        'A test route',
        async (input) => `Output: ${input}`,
        { keywords: ['test'], priority: 5 }
      );
      expect(route.keywords).toContain('test');
      expect(route.priority).toBe(5);
    });
  });
});
