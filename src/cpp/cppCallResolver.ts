// Cross-file call resolution for the C++ tokenizer tier.
//
// Resolution order, most to least confident:
//  1. object creation of a type declared in the same file (`new PaymentService(...)` -> constructor);
//  2. a method of the enclosing class (`this->load()` / `load()` inside a member);
//  3. a declaration in the same file (free function, or a method picked by name);
//  4. a method of a type named by the qualifier (`PaymentService::create()`, `service.process()`
//     when `service`'s declared type is `PaymentService`);
//  5. a method of a base class of the enclosing class (inheritance);
//  6. fuzzy qualifier -> type name matching (`gateway` -> `PaymentGateway`);
//  7. a declaration reachable through one of the file's `#include`s, when exactly one target
//     qualifies.
// When nothing matches the call stays unresolved instead of being guessed.

import { CppBoundSource } from './cppAnalysisContext';
import {
  CppCallSite,
  CppFileOutline,
  CppFunctionDef,
  CppTypeDef,
  normalizeTypeName,
} from './cppFileOutline';

/** A call resolved to a declaration that really exists in `source`. */
export interface CppResolvedCall {
  source: CppBoundSource;
  definition: CppFunctionDef;
}

/** Resolves an included header to its parsed source. */
export type IncludedSourceResolver = (
  source: CppBoundSource,
  specifier: string,
  isSystem: boolean
) => CppBoundSource | undefined;

interface Candidate {
  call: CppResolvedCall;
  score: number;
}

const EXACT_SCORE = 100;
const PLURAL_SCORE = 90;
const AFFIX_SCORE = 70;
const CONTAINS_SCORE = 50;
const MIN_FUZZY_LENGTH = 3;
const MAX_BASE_DEPTH = 4;

export class CppCallResolver {
  resolve(
    source: CppBoundSource,
    site: CppCallSite,
    includedSource: IncludedSourceResolver
  ): CppResolvedCall | undefined {
    const outline = source.outline;
    const enclosing = outline.functionContaining(site.offset);

    // 1. Object creation of a type declared right here.
    const directType = outline.typeNamed(site.name);
    if (directType !== undefined) {
      const constructor = this.constructorOf(source, directType);
      if (constructor !== undefined) {
        return constructor;
      }
    }

    // 2/3. Unqualified and `this->` calls.
    if (site.qualifier === null || site.qualifier === 'this') {
      if (enclosing !== undefined && enclosing.className !== null) {
        const owner = outline.typeNamed(enclosing.className);
        if (owner !== undefined) {
          const method = this.methodIncludingBases(source, owner, site.name, includedSource);
          if (method !== undefined) {
            return method;
          }
        }
      }
      if (site.qualifier === 'this') {
        return undefined;
      }
      const local = outline.functionNamed(site.name);
      if (local !== undefined) {
        return { source, definition: local };
      }
      return this.searchIncluded(source, site.name, includedSource);
    }

    // 4a. Qualifier is a declared type: `PaymentService::create()`.
    const qualifierType = outline.typeNamed(site.qualifier);
    if (qualifierType !== undefined) {
      if (site.isConstructor || site.name === qualifierType.name) {
        const constructor = this.constructorOf(source, qualifierType);
        if (constructor !== undefined) {
          return constructor;
        }
      }
      const method = this.methodIncludingBases(source, qualifierType, site.name, includedSource);
      if (method !== undefined) {
        return method;
      }
    }

    // 4b. Qualifier is a parameter/local/member with a declared type.
    const declaredType = this.declaredTypeOf(source, enclosing, site.qualifier);
    if (declaredType !== undefined) {
      const resolved = this.methodOfTypeName(source, declaredType, site.name, includedSource);
      if (resolved !== undefined) {
        return resolved;
      }
    }

    // 5/6. Fuzzy qualifier-to-type matching, then included declarations.
    const fuzzy = this.bestFuzzyMatch(source, site, enclosing, includedSource);
    if (fuzzy !== undefined) {
      return fuzzy;
    }
    return this.searchIncluded(source, site.name, includedSource);
  }

  /** Whether `site` names a constructor of a type declared in `source` (object creation). */
  isConstructorCall(
    source: CppBoundSource,
    site: CppCallSite,
    _includedSource: IncludedSourceResolver
  ): boolean {
    if (site.isConstructor) {
      return true;
    }
    const type = source.outline.typeNamed(site.name) ?? source.outline.typeNamed(site.qualifier ?? '');
    return type !== undefined;
  }

  // -----------------------------------------------------------------------------------------------
  // Types and members
  // -----------------------------------------------------------------------------------------------

  private constructorOf(source: CppBoundSource, type: CppTypeDef): CppResolvedCall | undefined {
    const constructors = source.outline.functionsIn(type).filter((fn) => fn.isConstructor);
    const definition = constructors.find((fn) => !fn.isDeclaration) ?? constructors[0];
    return definition !== undefined ? { source, definition } : undefined;
  }

  private methodIncludingBases(
    source: CppBoundSource,
    type: CppTypeDef,
    name: string,
    includedSource: IncludedSourceResolver,
    depth = 0
  ): CppResolvedCall | undefined {
    const own = source.outline.methodIn(type, name);
    if (own !== undefined) {
      return { source, definition: own };
    }
    if (depth >= MAX_BASE_DEPTH) {
      return undefined;
    }
    for (const base of type.bases) {
      const localBase = source.outline.typeNamed(base);
      if (localBase !== undefined) {
        const inherited = this.methodIncludingBases(source, localBase, name, includedSource, depth + 1);
        if (inherited !== undefined) {
          return inherited;
        }
        continue;
      }
      const included = this.includedSources(source, includedSource);
      for (const target of included) {
        const baseType = target.outline.typeNamed(base);
        if (baseType === undefined) {
          continue;
        }
        const inherited = target.outline.methodIn(baseType, name);
        if (inherited !== undefined) {
          return { source: target, definition: inherited };
        }
      }
    }
    return undefined;
  }

  /** Resolves `name` on the type spelled `typeName` (local first, then included headers). */
  private methodOfTypeName(
    source: CppBoundSource,
    typeName: string,
    name: string,
    includedSource: IncludedSourceResolver
  ): CppResolvedCall | undefined {
    const local = source.outline.typeNamed(typeName);
    if (local !== undefined) {
      const method = this.methodIncludingBases(source, local, name, includedSource);
      if (method !== undefined) {
        return method;
      }
    }
    const bare = normalizeTypeName(typeName);
    if (bare.length === 0) {
      return undefined;
    }
    for (const target of this.includedSources(source, includedSource)) {
      const type = target.outline.typeNamed(bare);
      if (type === undefined) {
        continue;
      }
      const method = target.outline.methodIn(type, name);
      if (method !== undefined) {
        return { source: target, definition: method };
      }
    }
    return undefined;
  }

  private declaredTypeOf(
    source: CppBoundSource,
    enclosing: CppFunctionDef | undefined,
    qualifier: string
  ): string | undefined {
    if (enclosing === undefined) {
      return undefined;
    }
    const fromScope = source.outline.variableType(enclosing, qualifier);
    if (fromScope !== undefined) {
      return fromScope;
    }
    if (enclosing.className !== null) {
      const owner = source.outline.typeNamed(enclosing.className);
      if (owner !== undefined) {
        const field = source.outline.fieldNamed(owner, qualifier);
        if (field !== undefined) {
          return field.type;
        }
      }
    }
    return undefined;
  }

  private bestFuzzyMatch(
    source: CppBoundSource,
    site: CppCallSite,
    enclosing: CppFunctionDef | undefined,
    includedSource: IncludedSourceResolver
  ): CppResolvedCall | undefined {
    const qualifier = site.qualifier;
    if (qualifier === null || qualifier.length < MIN_FUZZY_LENGTH) {
      return undefined;
    }
    const candidates: Candidate[] = [];
    const consider = (target: CppBoundSource, type: CppTypeDef): void => {
      const method = target.outline.methodIn(type, site.name);
      if (method === undefined) {
        return;
      }
      const score = bindingScore(qualifier, type.name);
      if (score > 0) {
        candidates.push({ call: { source: target, definition: method }, score });
      }
    };
    for (const type of source.outline.types) {
      consider(source, type);
    }
    for (const target of this.includedSources(source, includedSource)) {
      for (const type of target.outline.types) {
        consider(target, type);
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }
    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0];
    const sameScore = candidates.filter((candidate) => candidate.score === best.score);
    if (sameScore.length !== 1) {
      return undefined;
    }
    return best.call;
  }

  /**
   * Last resort: exactly one directly included file declares a function or method named `name`.
   * Overloads in one file are not ambiguous; the same name in several files is.
   */
  private searchIncluded(
    source: CppBoundSource,
    name: string,
    includedSource: IncludedSourceResolver
  ): CppResolvedCall | undefined {
    const candidates: Candidate[] = [];
    for (const target of this.includedSources(source, includedSource)) {
      const fn = target.outline.functionNamed(name);
      if (fn !== undefined) {
        candidates.push({ call: { source: target, definition: fn }, score: 0 });
      }
      for (const type of target.outline.types) {
        const method = target.outline.methodIn(type, name);
        if (method !== undefined) {
          candidates.push({ call: { source: target, definition: method }, score: 0 });
        }
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }
    const files = new Set(candidates.map((candidate) => candidate.call.source.filePath));
    if (files.size !== 1) {
      return undefined;
    }
    const definitions = candidates.filter((candidate) => !candidate.call.definition.isDeclaration);
    const pool = definitions.length > 0 ? definitions : candidates;
    return pool[0].call;
  }

  private includedSources(
    source: CppBoundSource,
    includedSource: IncludedSourceResolver
  ): CppBoundSource[] {
    const result: CppBoundSource[] = [];
    const seen = new Set<string>();
    for (const include of source.outline.includes) {
      if (seen.has(include.specifier)) {
        continue;
      }
      seen.add(include.specifier);
      const target = includedSource(source, include.specifier, include.isSystem);
      if (target === undefined) {
        continue;
      }
      if (target.filePath === source.filePath || seen.has(target.filePath)) {
        continue;
      }
      seen.add(target.filePath);
      result.push(target);
    }
    return result;
  }
}

/** Relation between `qualifier` and a type name in `0..100`; `0` means "unrelated". */
export function bindingScore(qualifier: string, candidate: string): number {
  const left = normalizeName(qualifier);
  const right = normalizeName(candidate);
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  if (left === right) {
    return EXACT_SCORE;
  }
  if (singular(left) === singular(right)) {
    return PLURAL_SCORE;
  }
  if (left.length < MIN_FUZZY_LENGTH || right.length < MIN_FUZZY_LENGTH) {
    return 0;
  }
  if (right.endsWith(left) || left.endsWith(right)) {
    return AFFIX_SCORE;
  }
  if (right.includes(left) || left.includes(right)) {
    return CONTAINS_SCORE;
  }
  return 0;
}

function normalizeName(value: string): string {
  return normalizeTypeName(value).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function singular(value: string): string {
  return value.length > MIN_FUZZY_LENGTH && value.endsWith('s') ? value.slice(0, -1) : value;
}
