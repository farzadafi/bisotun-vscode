// Cross-file call resolution for the Go tokenizer tier.
//
// Resolution order, most to least confident:
//  1. an import alias qualifier (`fmt.Println` / `models.NewUser`) resolved through `go.mod`;
//  2. a method of the enclosing receiver type (`s.Process()` / `Process()` inside a method),
//     including promoted methods of embedded structs;
//  3. a function of the same package (the current file first, then its siblings);
//  4. a method of a type named by the qualifier's declared type (`service.Process()` when
//     `service` is declared as `*PaymentService`), including embedded and interface methods;
//  5. fuzzy qualifier -> type name matching (`gateway` -> `PaymentGateway`);
// when nothing matches the call stays unresolved instead of being guessed.

import { GoBoundSource } from './goAnalysisContext';
import {
  GoCallSite,
  GoFileOutline,
  GoFunctionDef,
  GoTypeDef,
  baseTypeName,
  containerTypeName,
} from './goFileOutline';

/** A call resolved to a declaration that really exists in `source`. */
export interface GoResolvedCall {
  source: GoBoundSource;
  definition: GoFunctionDef;
}

/** Resolves an import path from a source file to the sources of the imported package. */
export type GoPackageResolver = (
  source: GoBoundSource,
  importPath: string
) => GoBoundSource[] | undefined;

const EXACT_SCORE = 100;
const PLURAL_SCORE = 90;
const AFFIX_SCORE = 70;
const CONTAINS_SCORE = 50;
const MIN_FUZZY_LENGTH = 3;
const MAX_EMBEDDED_DEPTH = 4;

interface Candidate {
  call: GoResolvedCall;
  score: number;
}

export class GoCallResolver {
  resolve(
    source: GoBoundSource,
    site: GoCallSite,
    samePackage: GoBoundSource[],
    resolveImport: GoPackageResolver
  ): GoResolvedCall | undefined {
    const outline = source.outline;
    const enclosing = outline.functionContaining(site.offset);
    const qualifier = site.qualifier;

    // 1. Package-qualified call: `pkg.Function(...)`.
    if (qualifier !== null) {
      const imported = outline.importNamed(qualifier);
      if (imported !== undefined) {
        for (const target of resolveImport(source, imported.path) ?? []) {
          const fn = target.outline.functionNamed(site.name);
          if (fn !== undefined) {
            return { source: target, definition: fn };
          }
        }
        return undefined;
      }
    }

    // 2/3. Bare and receiver calls.
    if (qualifier === null) {
      if (enclosing !== undefined && enclosing.receiverType !== null) {
        const method = this.methodOfType(
          source,
          enclosing.receiverType,
          site.name,
          samePackage,
          resolveImport,
          0
        );
        if (method !== undefined) {
          return method;
        }
      }
      for (const candidate of [source, ...samePackage]) {
        const fn = candidate.outline.functionNamed(site.name);
        if (fn !== undefined) {
          return { source: candidate, definition: fn };
        }
      }
      return undefined;
    }

    // 4. Qualifier with a declared type (`service.Process()`, `handler.Handle()`).
    const declaredType = this.declaredTypeOf(source, enclosing, qualifier);
    if (declaredType !== undefined) {
      const resolved = this.methodOfQualifiedType(
        source,
        declaredType,
        site.name,
        samePackage,
        resolveImport,
        0
      );
      if (resolved !== undefined) {
        return resolved;
      }
    }

    // 5. Fuzzy qualifier -> type matching, when exactly one candidate qualifies.
    return this.bestFuzzyMatch(source, site, samePackage);
  }

  // -----------------------------------------------------------------------------------------------
  // Types and members
  // -----------------------------------------------------------------------------------------------

  /** Resolves `name` on the type spelled `typeText` (local package first, then imported ones). */
  private methodOfQualifiedType(
    source: GoBoundSource,
    typeText: string,
    name: string,
    samePackage: GoBoundSource[],
    resolveImport: GoPackageResolver,
    depth: number
  ): GoResolvedCall | undefined {
    const base = baseTypeName(typeText);
    if (base.length === 0) {
      return undefined;
    }
    const qualifier = packageQualifierOf(typeText);
    if (qualifier !== null) {
      const imported = source.outline.importNamed(qualifier);
      if (imported !== undefined) {
        const targets = resolveImport(source, imported.path) ?? [];
        for (const target of targets) {
          const type = target.outline.typeNamed(base);
          if (type !== undefined) {
            const resolved = this.methodIncludingEmbedded(
              target,
              type,
              name,
              targets,
              resolveImport,
              depth
            );
            if (resolved !== undefined) {
              return resolved;
            }
          }
        }
        return undefined;
      }
    }
    return this.methodOfType(source, base, name, samePackage, resolveImport, depth);
  }

  private methodOfType(
    source: GoBoundSource,
    typeName: string,
    name: string,
    samePackage: GoBoundSource[],
    resolveImport: GoPackageResolver,
    depth: number
  ): GoResolvedCall | undefined {
    const sources = [source, ...samePackage];
    for (const candidate of sources) {
      const type = candidate.outline.typeNamed(typeName);
      if (type === undefined) {
        continue;
      }
      const resolved = this.methodIncludingEmbedded(
        candidate,
        type,
        name,
        sources,
        resolveImport,
        depth
      );
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return undefined;
  }

  /** Own methods, interface signatures and promoted methods of embedded structs. */
  private methodIncludingEmbedded(
    source: GoBoundSource,
    type: GoTypeDef,
    name: string,
    packageSources: GoBoundSource[],
    resolveImport: GoPackageResolver,
    depth: number
  ): GoResolvedCall | undefined {
    const own = source.outline.methodIn(type, name);
    if (own !== undefined) {
      return { source, definition: own };
    }
    if (depth >= MAX_EMBEDDED_DEPTH) {
      return undefined;
    }
    for (const embedded of type.embeddeds) {
      const base = baseTypeName(embedded.type);
      if (base.length === 0) {
        continue;
      }
      const qualifier = packageQualifierOf(embedded.type);
      if (qualifier !== null) {
        const imported = source.outline.importNamed(qualifier);
        if (imported === undefined) {
          continue;
        }
        const targets = resolveImport(source, imported.path) ?? [];
        for (const target of targets) {
          const embeddedType = target.outline.typeNamed(base);
          if (embeddedType === undefined) {
            continue;
          }
          const resolved = this.methodIncludingEmbedded(
            target,
            embeddedType,
            name,
            targets,
            resolveImport,
            depth + 1
          );
          if (resolved !== undefined) {
            return resolved;
          }
        }
        continue;
      }
      for (const candidate of packageSources) {
        const embeddedType = candidate.outline.typeNamed(base);
        if (embeddedType === undefined) {
          continue;
        }
        const resolved = this.methodIncludingEmbedded(
          candidate,
          embeddedType,
          name,
          packageSources,
          resolveImport,
          depth + 1
        );
        if (resolved !== undefined) {
          return resolved;
        }
      }
    }
    return undefined;
  }

  private declaredTypeOf(
    source: GoBoundSource,
    enclosing: GoFunctionDef | undefined,
    qualifier: string
  ): string | undefined {
    const outline = source.outline;
    if (enclosing !== undefined) {
      const fromScope = outline.variableType(enclosing, qualifier);
      if (fromScope !== undefined) {
        return fromScope;
      }
      if (enclosing.receiverType !== null) {
        const owner = outline.typeNamed(enclosing.receiverType);
        if (owner !== undefined) {
          const field = outline.fieldsIn(owner).find((candidate) => candidate.name === qualifier);
          if (field !== undefined) {
            return field.type;
          }
        }
      }
    }
    return outline.valueNamed(qualifier)?.type;
  }

  private bestFuzzyMatch(
    source: GoBoundSource,
    site: GoCallSite,
    samePackage: GoBoundSource[]
  ): GoResolvedCall | undefined {
    const qualifier = site.qualifier;
    if (qualifier === null || qualifier.length < MIN_FUZZY_LENGTH) {
      return undefined;
    }
    const candidates: Candidate[] = [];
    for (const candidate of [source, ...samePackage]) {
      for (const type of candidate.outline.types) {
        const method = candidate.outline.methodIn(type, site.name);
        if (method === undefined) {
          continue;
        }
        const score = bindingScore(qualifier, type.name);
        if (score > 0) {
          candidates.push({ call: { source: candidate, definition: method }, score });
        }
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }
    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0];
    if (candidates.filter((candidate) => candidate.score === best.score).length !== 1) {
      return undefined;
    }
    return best.call;
  }
}

/** Package qualifier of a type reference (`models.User` -> `models`, `*pkg.T` -> `pkg`). */
export function packageQualifierOf(typeText: string): string | null {
  const value = containerTypeName(typeText);
  const dot = value.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const prefix = value.substring(0, dot).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix) ? prefix : null;
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
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function singular(value: string): string {
  return value.length > MIN_FUZZY_LENGTH && value.endsWith('s') ? value.slice(0, -1) : value;
}

/** Re-exported for the extractor so both tiers agree on what counts as a declared package symbol. */
export type { GoFileOutline };
