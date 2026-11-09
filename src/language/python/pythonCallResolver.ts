// Python call resolver - cross file resolution, mirrors the JetBrains plugin's
// `PythonCallResolver` (a port of the JS/TS resolver tiering).
//
// Resolution order, most to least confident:
//
//  1. a declaration in the same file - plain `notify()` and `self._helper()`/`cls._helper()`;
//  2. an exact import binding - `from module import ClassName` and `import module`;
//  3. an imported binding whose name relates to the instance qualifier
//     (`payment_service` -> `PaymentService`, `gateway` -> `PaymentGateway`);
//  4. any imported file that declares a class method (preferred) or module function with the
//     called name, when exactly one target file qualifies.
//
// Every step resolves through the `PythonFileOutline` of the target file, so a resolution can
// never point at invented source. Calls that cannot be matched stay unresolved.

import { PythonBoundSource } from './pythonAnalysisContext';
import {
  PythonCallSite,
  PythonFileOutline,
  PythonFunctionDef,
  PythonImportBinding,
  PythonTypeDef,
} from './pythonFileOutline';

export interface PythonResolvedCall {
  source: PythonBoundSource;
  definition: PythonFunctionDef;
}

const SELF = 'self';
const CLS = 'cls';
const MEMBER_TIER = 2;
const MODULE_TIER = 1;

/**
 * Qualifiers that never point at an importable declaration, so member calls on them are never
 * resolved through `resolveByImportedDeclaration`. Python builtins and common stdlib modules never
 * contain project declarations.
 */
const PYTHON_GLOBALS = new Set([
  'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed',
  'sum', 'min', 'max', 'abs', 'round', 'divmod', 'pow', 'type', 'isinstance', 'issubclass',
  'id', 'hash', 'repr', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'frozenset', 'bytes', 'bytearray', 'object', 'super', 'staticmethod', 'classmethod',
  'property', 'open', 'input', 'getattr', 'setattr', 'vars', 'dir', 'globals', 'locals',
  'format', 'ord', 'chr', 'bin', 'hex', 'oct', 'all', 'any', 'next', 'iter', 'slice',
  'callable', 'hasattr', 'exec', 'eval', 'compile', 'Exception', 'BaseException',
  'ValueError', 'TypeError', 'KeyError', 'AttributeError', 'IndexError', 'RuntimeError',
  'NotImplementedError', 'os', 'sys', 'json', 're', 'math', 'datetime', 'time', 'random',
  'collections', 'string', 'pathlib', 'functools', 'itertools', 'unittest', 'typing',
  'requests', 'flask', 'django',
]);

export class PythonCallResolver {
  resolve(
    source: PythonBoundSource,
    site: PythonCallSite,
    importedSource: ImportedSourceResolver
  ): PythonResolvedCall | undefined {
    const qualifier = site.qualifier;
    if (qualifier === null || qualifier === SELF || qualifier === CLS) {
      const local = source.outline.functionNamed(site.name);
      if (local !== undefined && local.startOffset !== site.offset) {
        return { source, definition: local };
      }
      if (qualifier === SELF || qualifier === CLS) return undefined;
    }
    if (qualifier === null) {
      const binding = source.outline.importFor(site.name);
      if (!binding) return undefined;
      return this.resolveBinding(source, binding, importedSource);
    }
    return this.resolveMemberCall(source, site, qualifier, importedSource);
  }

  /**
   * Whether a bare call names a class (a constructor reference) rather than a function to invoke.
   *
   * A bare `PaymentService()` whose name maps to either a local class declaration or to a class in
   * an imported file instantiates an object: it contributes a MODEL (picked up by model collection)
   * but never an execution node. The crawler drops these sites instead of emitting UNRESOLVED nodes.
   */
  isConstructorCall(
    source: PythonBoundSource,
    site: PythonCallSite,
    importedSource: ImportedSourceResolver
  ): boolean {
    if (site.qualifier !== null || site.qualifier === SELF || site.qualifier === CLS) return false;
    const localType = source.outline.typeNamed(site.name);
    if (localType && localType.startOffset !== site.offset) return true;
    const binding = source.outline.importFor(site.name);
    if (!binding || binding.isModule || !binding.importedName) return false;
    const targetSource = importedSource(source, binding.specifier);
    if (!targetSource) return false;
    return targetSource.outline.typeNamed(binding.importedName) !== undefined;
  }

  /** `service.processPayment()` / `self.client.processPayment()`. */
  private resolveMemberCall(
    source: PythonBoundSource,
    site: PythonCallSite,
    qualifier: string,
    importedSource: ImportedSourceResolver
  ): PythonResolvedCall | undefined {
    // `self.<field>.<method>()`: the field is typed by its declaration in `__init__` (or a class
    // level annotation), and the method belongs to that declared type. This tier runs before the
    // name-matching tiers so a resolve never depends on a textual relation between `field` and the
    // class name.
    if (site.rootIdentifier === SELF && qualifier !== SELF) {
      const fieldType = this.fieldTypeOfSelfCall(source, site, qualifier);
      if (fieldType) {
        const resolved = this.resolveThroughAttributeType(source, fieldType, site.name, importedSource);
        if (resolved) return resolved;
      }
    }

    const local = this.localMember(source, qualifier, site.name);
    if (local) return local;

    const exact = source.outline.importFor(qualifier);
    if (exact) {
      const resolved = this.resolveBindingMember(source, exact, site.name, importedSource);
      if (resolved) return resolved;
    }

    const fuzzyBindings = source.outline.imports
      .filter((it) => it !== exact)
      .map((it) => ({ binding: it, score: PythonBindingMatcher.bindingScore(qualifier, it) }))
      .filter((it) => it.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { binding } of fuzzyBindings) {
      const resolved = this.resolveBindingMember(source, binding, site.name, importedSource);
      if (resolved) return resolved;
    }

    // Python builtins never point at an import.
    if (PYTHON_GLOBALS.has(qualifier)) return undefined;
    return this.resolveByImportedDeclaration(source, qualifier, site.name, importedSource);
  }

  /** Class method named `memberName` declared in this file for an instance called `qualifier`. */
  private localMember(
    source: PythonBoundSource,
    qualifier: string,
    memberName: string
  ): PythonResolvedCall | undefined {
    const outline = source.outline;
    const bestType = outline.types
      .map((type) => ({ type, score: PythonBindingMatcher.score(qualifier, type.name) }))
      .filter((it) => it.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.type;
    if (bestType) {
      const method = outline.methodIn(bestType, memberName);
      if (method) return { source, definition: method };
    }
    const candidates = outline.types
      .map((type) => outline.methodIn(type, memberName))
      .filter((method): method is PythonFunctionDef => method !== undefined)
      .filter(
        (method, index, all) =>
          all.findIndex((m) => m.startOffset === method.startOffset) === index
      );
    return candidates.length === 1 ? { source, definition: candidates[0] } : undefined;
  }

  /**
   * The declared type of the field in `self.<field>` inside the class that owns the call. The call
   * sits at `site.offset`; the class is the smallest type whose span contains it (the localMember
   * path already handles `self` calls, so this only runs when `qualifier` is a real field).
   *
   * Returns an identifier, not a declaration - both `PythonFileOutline.attributeTypeOfClass` and the
   * import-based resolution remain conservative.
   */
  private fieldTypeOfSelfCall(
    source: PythonBoundSource,
    site: PythonCallSite,
    qualifier: string
  ): string | undefined {
    const owner = source.outline
      .types
      .filter((type) => site.offset >= type.startOffset && site.offset <= type.endOffset)
      .sort((a, b) => b.startOffset - a.startOffset)[0];
    if (!owner) return undefined;
    return source.outline.attributeTypeOfClass(owner, qualifier);
  }

  /**
   * Resolves a method on the instance of the type the field was declared with:
   *
   *   1. a type declared in the same file;
   *   2. a `from module import TypeName` binding (the common fixture shape);
   *   3. a type `TypeName` living inside any imported module (`import repositories`).
   *
   * Every branch proves the declaration exists before it resolves - field-name guessing never
   * happens.
   */
  private resolveThroughAttributeType(
    source: PythonBoundSource,
    typeName: string,
    memberName: string,
    importedSource: ImportedSourceResolver
  ): PythonResolvedCall | undefined {
    const localType = source.outline.typeNamed(typeName);
    if (localType) {
      const localMethod = source.outline.methodIn(localType, memberName);
      if (localMethod) return { source, definition: localMethod };
    }

    const exact = source.outline.importFor(typeName);
    if (exact && !exact.isModule) {
      const resolved = this.resolveBindingMember(source, exact, memberName, importedSource);
      if (resolved) return resolved;
    }

    // `import repositories` (or `import pkg.repositories`): the field type may be a class in that
    // module. A module binding never resolves a class method through `resolveBindingMember`, so the
    // type is confirmed in the target module explicitly.
    for (const binding of source.outline.imports) {
      if (!binding.isModule || !binding.localName) continue;
      const targetSource = importedSource(source, binding.specifier);
      if (!targetSource) continue;
      const targetType = targetSource.outline.typeNamed(typeName);
      if (!targetType) continue;
      const method = targetSource.outline.methodIn(targetType, memberName);
      if (method) return { source: targetSource, definition: method };
    }
    return undefined;
  }

  /** `from module import ClassName` used directly, e.g. `ClassName.method()`. */
  private resolveBinding(
    source: PythonBoundSource,
    binding: PythonImportBinding,
    importedSource: ImportedSourceResolver
  ): PythonResolvedCall | undefined {
    const targetSource = importedSource(source, binding.specifier);
    if (!targetSource) return undefined;
    const definition =
      binding.importedName !== null
        ? targetSource.outline.functionNamed(binding.importedName)
        : undefined;
    if (!definition) return undefined;
    return { source: targetSource, definition };
  }

  /**
   * Resolves `memberName` inside the declaration `binding` points at: the module function first,
   * then a class method when the target has no such module function. A class/import that does not
   * declare `memberName` keeps the call unresolved instead of falling back to an unrelated module
   * function.
   */
  private resolveBindingMember(
    source: PythonBoundSource,
    binding: PythonImportBinding,
    memberName: string,
    importedSource: ImportedSourceResolver
  ): PythonResolvedCall | undefined {
    const targetSource = importedSource(source, binding.specifier);
    if (!targetSource) return undefined;
    const target = targetSource.outline;
    const moduleFunc = target.functionNamed(memberName);
    if (moduleFunc) return { source: targetSource, definition: moduleFunc };

    const type = this.resolveImportedType(target, binding);
    if (!type) return undefined;
    const method = target.methodIn(type, memberName);
    if (!method) return undefined;
    return { source: targetSource, definition: method };
  }

  /** The class a `from` binding points at. */
  private resolveImportedType(
    outline: PythonFileOutline,
    binding: PythonImportBinding
  ): PythonTypeDef | undefined {
    if (binding.isModule) return undefined;
    if (binding.importedName) {
      const type = outline.typeNamed(binding.importedName);
      if (type) return type;
    }
    return this.findMatchingType(outline, binding);
  }

  /** Class whose name is the closest structural match for an aliased import. */
  private findMatchingType(
    outline: PythonFileOutline,
    binding: PythonImportBinding
  ): PythonTypeDef | undefined {
    const names = [binding.importedName, binding.localName].filter(
      (name): name is string => name !== null
    );
    let best: { type: PythonTypeDef; score: number } | undefined;
    for (const type of outline.types) {
      const score = Math.max(...names.map((name) => PythonBindingMatcher.score(name, type.name)));
      if (score > 0 && (!best || score > best.score)) best = { type, score };
    }
    return best?.type;
  }

  /**
   * Last resort: the qualifier has no name relation to any import, but exactly one imported file
   * declares a class method (preferred) or module function called `memberName`. Ambiguous matches
   * stay unresolved.
   */
  private resolveByImportedDeclaration(
    source: PythonBoundSource,
    qualifier: string,
    memberName: string,
    importedSource: ImportedSourceResolver
  ): PythonResolvedCall | undefined {
    interface Candidate {
      call: PythonResolvedCall;
      tier: number;
      score: number;
      filePath: string;
    }
    const candidates: Candidate[] = [];
    const seenSpecifiers = new Set<string>();
    for (const binding of source.outline.imports) {
      if (seenSpecifiers.has(binding.specifier)) continue;
      seenSpecifiers.add(binding.specifier);
      const targetSource = importedSource(source, binding.specifier);
      if (!targetSource) continue;
      const target = targetSource.outline;
      for (const type of target.types) {
        const definition = target.methodIn(type, memberName);
        if (!definition) continue;
        candidates.push({
          call: { source: targetSource, definition },
          tier: MEMBER_TIER,
          score: PythonBindingMatcher.score(qualifier, type.name),
          filePath: targetSource.filePath,
        });
      }
      const definition = target.functionNamed(memberName);
      if (!definition) continue;
      candidates.push({
        call: { source: targetSource, definition },
        tier: MODULE_TIER,
        score: 0,
        filePath: targetSource.filePath,
      });
    }
    const bestTier = candidates.reduce((max, c) => Math.max(max, c.tier), 0);
    if (bestTier === 0) return undefined;
    const inTier = candidates.filter((c) => c.tier === bestTier);
    const bestScore = Math.max(...inTier.map((c) => c.score));
    const best = inTier.filter((c) => c.score === bestScore);
    return new Set(best.map((c) => c.filePath)).size === 1 ? best[0].call : undefined;
  }
}

/** Resolves an import specifier of `source` to another parsed source (may be a disk read). */
export type ImportedSourceResolver = (
  source: PythonBoundSource,
  specifier: string
) => PythonBoundSource | undefined;

/**
 * Pure name matching used to relate an instance qualifier to an imported binding, mirroring the
 * JetBrains `PythonBindingMatcher`.
 *
 * A call such as `payment_service.processPayment()` names the *instance* (`payment_service`), while
 * the class is imported as `PaymentService`. Matching is only a filter: the resolver must still
 * find the called member inside the matched target, so a match can never fabricate a declaration.
 */
export class PythonBindingMatcher {
  static readonly MIN_FUZZY_LENGTH = 4;
  private static readonly EXACT_SCORE = 100;
  private static readonly PLURAL_SCORE = 90;
  private static readonly AFFIX_SCORE = 70;
  private static readonly CONTAINS_SCORE = 50;

  /** Relation between `qualifier` and `candidate` in `0..100`; `0` means "unrelated". */
  static score(qualifier: string, candidate: string): number {
    const left = this.normalize(qualifier);
    const right = this.normalize(candidate);
    if (left.length === 0 || right.length === 0) return 0;
    if (left === right) return this.EXACT_SCORE;
    if (this.singular(left) === this.singular(right)) return this.PLURAL_SCORE;
    if (left.length < this.MIN_FUZZY_LENGTH || right.length < this.MIN_FUZZY_LENGTH) return 0;
    if (right.endsWith(left) || left.endsWith(right)) return this.AFFIX_SCORE;
    if (right.includes(left) || left.includes(right)) return this.CONTAINS_SCORE;
    return 0;
  }

  /** Best score of `qualifier` against the names exposed by `binding`. */
  static bindingScore(qualifier: string, binding: PythonImportBinding): number {
    const imported = binding.importedName !== null ? this.score(qualifier, binding.importedName) : 0;
    return Math.max(this.score(qualifier, binding.localName), imported);
  }

  private static normalize(value: string): string {
    return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  }

  private static singular(value: string): string {
    return value.length > this.MIN_FUZZY_LENGTH && value.endsWith('s')
      ? value.slice(0, -1)
      : value;
  }
}
