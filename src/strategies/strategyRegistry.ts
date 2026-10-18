import { LanguageStrategy } from './languageStrategy';
import { JavaStrategy } from './javaStrategy';

class StrategyRegistry {
  private strategies: Map<string, LanguageStrategy> = new Map();

  constructor() {
    this.register(new JavaStrategy());
  }

  register(strategy: LanguageStrategy): void {
    this.strategies.set(strategy.languageId, strategy);
  }

  getStrategy(languageId: string): LanguageStrategy | undefined {
    return this.strategies.get(languageId);
  }
}

export const strategyRegistry = new StrategyRegistry();
