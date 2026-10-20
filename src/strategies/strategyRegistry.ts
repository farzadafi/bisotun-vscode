import { LanguageStrategy } from './languageStrategy';
import { JavaScriptStrategy } from './javascriptStrategy';
import { JavaStrategy } from './javaStrategy';

class StrategyRegistry {
  private readonly strategies = new Map<string, LanguageStrategy>();

  constructor() {
    this.register(new JavaStrategy());
    this.register(new JavaScriptStrategy());
  }

  register(strategy: LanguageStrategy): void {
    this.strategies.set(strategy.languageId, strategy);
  }

  getStrategy(languageId: string): LanguageStrategy | undefined {
    const exactStrategy = this.strategies.get(languageId);

    if (exactStrategy) {
      return exactStrategy;
    }

    for (const strategy of this.strategies.values()) {
      if (strategy.supports(languageId)) {
        return strategy;
      }
    }

    return undefined;
  }
}

export const strategyRegistry = new StrategyRegistry();