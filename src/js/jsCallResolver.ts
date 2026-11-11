// Cross-file call resolution for the JS/TS tokenizer tier.
//
// Port of the JetBrains `JsCallResolver` + `JsBindingMatcher` (part of the single JS/TS extraction
// strategy). Resolution order, most to least confident:
//  1. a declaration in the same file (`this.notify()` and plain `notify()`);
//  2. an exact import binding - namespace imports (`import * as api`) and class imports;
//  3. an imported binding whose name relates to the instance qualifier
//     (`paymentService` -> `PaymentService`, `gateway` -> `PaymentGateway`);
//  4. any imported file that declares a class method (preferred) or module function with the
//     called name, when exactly one target file qualifies.
// Every step returns a declaration looked up by name inside the target file; when nothing matches
// the call stays unresolved instead of being guessed.

import { JsBoundSource } from './jsAnalysisContext';
import {
  JsCallSite,
  JsFileOutline,
  JsFunctionDef,
  JsImportBinding,
  JsTypeDef,
} from './jsFileOutline';

/** A call resolved to a declaration that really exists in `source`. */
export interface JsResolvedCall {
  source: JsBoundSource;
  definition: JsFunctionDef;
}

/** Resolves the imported file for a specifier (specifier resolution plus reading/parsing). */
export type ImportedSourceResolver = (
  source: JsBoundSource,
  specifier: string
) => JsBoundSource | undefined;

interface Candidate {
  call: JsResolvedCall;
  tier: number;
  score: number;
  filePath: string;
}

export class JsCallResolver {
  resolve(
    source: JsBoundSource,
    site: JsCallSite,
    importedSource: ImportedSourceResolver
  ): JsResolvedCall | undefined {
    const qualifier = site.qualifier;
    if (qualifier === null || qualifier === THIS) {
      const local = source.outline.functionNamed(site.name);
      if (local !== undefined && local.startOffset !== site.offset) {
        return { source, definition: local };
      }
      if (qualifier === THIS) {return undefined;}
    }
    if (qualifier === null) {
      const binding = source.outline.importFor(site.name);
      if (binding === undefined) {return undefined;}
      return this.resolveBinding(source, binding, importedSource);
    }
    return this.resolveMemberCall(source, site, qualifier, importedSource);
  }

  /** `service.processPayment()` / `this.paymentService.processPayment()`. */
  private resolveMemberCall(
    source: JsBoundSource,
    site: JsCallSite,
    qualifier: string,
    importedSource: ImportedSourceResolver
  ): JsResolvedCall | undefined {
    const local = this.localMember(source, qualifier, site.name);
    if (local !== undefined) {return local;}

    const exact = source.outline.importFor(qualifier);
    if (exact !== undefined) {
      const member = this.resolveBindingMember(source, exact, site.name, importedSource);
      if (member !== undefined) {return member;}
    }

    const fuzzyBindings: Array<{ binding: JsImportBinding; score: number }> = [];
    for (const binding of source.outline.imports) {
      if (binding === exact) {continue;}
      const score = JsBindingMatcher.bindingScore(qualifier, binding);
      if (score > 0) {fuzzyBindings.push({ binding, score });}
    }
    fuzzyBindings.sort((a, b) => b.score - a.score);
    for (const { binding } of fuzzyBindings) {
      const member = this.resolveBindingMember(source, binding, site.name, importedSource);
      if (member !== undefined) {return member;}
    }

    // Host globals (`console.log`, `document.querySelector`, ...) never point at an import.
    if (GLOBAL_QUALIFIERS.has(qualifier)) {return undefined;}
    // A standard prototype method name never resolves to an unrelated imported declaration
    // (`db.set()` cannot "discover" `set()` in an arbitrary imported file); only a real
    // declaration exposed by a binding can rescue it.
    if (PROTOTYPE_METHODS.has(site.name) || BARE_FUNCTION_GLOBALS.has(site.name)) {
      return undefined;
    }
    return this.resolveByImportedDeclaration(source, qualifier, site.name, importedSource);
  }

  /** Class method named `memberName` declared in this file for an instance called `qualifier`. */
  private localMember(
    source: JsBoundSource,
    qualifier: string,
    memberName: string
  ): JsResolvedCall | undefined {
    const outline = source.outline;
    let bestType: JsTypeDef | undefined;
    let bestScore = 0;
    for (const type of outline.types) {
      const score = JsBindingMatcher.score(qualifier, type.name);
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }
    if (bestType !== undefined) {
      const method = outline.methodIn(bestType, memberName);
      if (method !== undefined) {return { source, definition: method };}
    }
    const candidates: JsFunctionDef[] = [];
    for (const type of outline.types) {
      const method = outline.methodIn(type, memberName);
      if (method !== undefined && !candidates.some((m) => m.startOffset === method.startOffset)) {
        candidates.push(method);
      }
    }
    if (candidates.length === 1) {return { source, definition: candidates[0] };}
    return undefined;
  }

  /** `import { Foo } from './foo'` used directly, e.g. `Foo.bar()` on a namespace-like module. */
  private resolveBinding(
    source: JsBoundSource,
    binding: JsImportBinding,
    importedSource: ImportedSourceResolver
  ): JsResolvedCall | undefined {
    const targetSource = importedSource(source, binding.specifier);
    if (targetSource === undefined) {return undefined;}
    let definition: JsFunctionDef | undefined;
    if (binding.importedName !== null) {
      definition = targetSource.outline.functionNamed(binding.importedName);
    } else if (!binding.isModule) {
      const defaultName = targetSource.outline.defaultExportName;
      if (defaultName !== null) {definition = targetSource.outline.functionNamed(defaultName);}
    }
    if (definition === undefined) {return undefined;}
    return { source: targetSource, definition };
  }

  /**
   * Resolves `memberName` inside the declaration `binding` points at: the exported class first
   * (its method, constructor or arrow field), then a module level declaration when the target has
   * no such class. A class that does not declare `memberName` keeps the call unresolved instead of
   * falling back to an unrelated module function.
   */
  private resolveBindingMember(
    source: JsBoundSource,
    binding: JsImportBinding,
    memberName: string,
    importedSource: ImportedSourceResolver
  ): JsResolvedCall | undefined {
    const targetSource = importedSource(source, binding.specifier);
    if (targetSource === undefined) {return undefined;}
    const target = targetSource.outline;
    if (binding.isModule) {
      const definition = target.functionNamed(memberName);
      if (definition === undefined) {return undefined;}
      return { source: targetSource, definition };
    }
    const exportedName = binding.importedName ?? target.defaultExportName ?? binding.localName;
    const type = target.typeNamed(exportedName) ?? findMatchingType(target, binding);
    if (type !== undefined) {
      const method = target.methodIn(type, memberName);
      if (method === undefined) {return undefined;}
      return { source: targetSource, definition: method };
    }
    const definition = target.functionNamed(memberName);
    if (definition === undefined) {return undefined;}
    return { source: targetSource, definition };
  }

  /**
   * Last resort: the qualifier has no name relation to any import, but exactly one imported file
   * declares a method (or module function) called `memberName`. Ambiguous matches stay unresolved.
   */
  private resolveByImportedDeclaration(
    source: JsBoundSource,
    qualifier: string,
    memberName: string,
    importedSource: ImportedSourceResolver
  ): JsResolvedCall | undefined {
    const candidates: Candidate[] = [];
    const seenSpecifiers = new Set<string>();
    for (const binding of source.outline.imports) {
      if (seenSpecifiers.has(binding.specifier)) {continue;}
      seenSpecifiers.add(binding.specifier);
      const targetSource = importedSource(source, binding.specifier);
      if (targetSource === undefined) {continue;}
      const target = targetSource.outline;
      for (const type of target.types) {
        const definition = target.methodIn(type, memberName);
        if (definition === undefined) {continue;}
        candidates.push({
          call: { source: targetSource, definition },
          tier: MEMBER_TIER,
          score: JsBindingMatcher.score(qualifier, type.name),
          filePath: targetSource.filePath,
        });
      }
      const definition = target.functionNamed(memberName);
      if (definition !== undefined) {
        candidates.push({
          call: { source: targetSource, definition },
          tier: MODULE_TIER,
          score: 0,
          filePath: targetSource.filePath,
        });
      }
    }
    if (candidates.length === 0) {return undefined;}
    let bestTier = 0;
    for (const candidate of candidates) {
      if (candidate.tier > bestTier) {bestTier = candidate.tier;}
    }
    const inTier = candidates.filter((c) => c.tier === bestTier);
    let bestScore = 0;
    for (const candidate of inTier) {
      if (candidate.score > bestScore) {bestScore = candidate.score;}
    }
    const best = inTier.filter((c) => c.score === bestScore);
    if (new Set(best.map((c) => c.filePath)).size !== 1) {return undefined;}
    return best[0].call;
  }
}

/** Pure name matching used to relate an instance qualifier to an imported binding. */
export const JsBindingMatcher = {
  /** Relation between `qualifier` and `candidate` in `0..100`; `0` means "unrelated". */
  score(qualifier: string, candidate: string): number {
    const left = normalize(qualifier);
    const right = normalize(candidate);
    if (left.length === 0 || right.length === 0) {return 0;}
    if (left === right) {return EXACT_SCORE;}
    if (singular(left) === singular(right)) {return PLURAL_SCORE;}
    if (left.length < MIN_FUZZY_LENGTH || right.length < MIN_FUZZY_LENGTH) {return 0;}
    if (right.endsWith(left) || left.endsWith(right)) {return AFFIX_SCORE;}
    if (right.includes(left) || left.includes(right)) {return CONTAINS_SCORE;}
    return 0;
  },

  /** Best score of `qualifier` against the names exposed by `binding`. */
  bindingScore(qualifier: string, binding: JsImportBinding): number {
    const imported = binding.importedName !== null ? this.score(qualifier, binding.importedName) : 0;
    return Math.max(this.score(qualifier, binding.localName), imported);
  },
};

/** Class whose name is the closest structural match for an aliased import. */
function findMatchingType(outline: JsFileOutline, binding: JsImportBinding): JsTypeDef | undefined {
  const names: string[] = [];
  if (binding.importedName !== null) {names.push(binding.importedName);}
  names.push(binding.localName);
  let bestType: JsTypeDef | undefined;
  let bestScore = 0;
  for (const type of outline.types) {
    const score = names.reduce(
      (max, name) => Math.max(max, JsBindingMatcher.score(name, type.name)),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }
  return bestType;
}

const THIS = 'this';
const MIN_FUZZY_LENGTH = 3;
const EXACT_SCORE = 100;
const PLURAL_SCORE = 90;
const AFFIX_SCORE = 70;
const CONTAINS_SCORE = 50;
const MEMBER_TIER = 2;
const MODULE_TIER = 1;

function normalize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function singular(value: string): string {
  return value.length > MIN_FUZZY_LENGTH && value.endsWith('s') ? value.slice(0, -1) : value;
}

/** Host globals are never project behavior: a call on one stays unresolved (never expanded). */
export const GLOBAL_QUALIFIERS = new Set([
  'console', 'window', 'document', 'globalThis', 'global', 'Math', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Date', 'DateUTC', 'Promise', 'Reflect', 'Symbol', 'Error',
  'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'process', 'module', 'exports', 'localStorage',
  'sessionStorage', 'navigator', 'location', 'history', 'fetch', 'require', 'Intl', 'URL',
  'URLSearchParams', 'Headers', 'AbortController', 'AbortSignal', 'Request', 'Response', 'FormData',
  'Blob', 'File', 'FileReader', 'TextEncoder', 'TextDecoder', 'WebSocket', 'EventSource', 'crypto',
  'performance', 'Buffer', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'Int8Array',
  'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
]);

/**
 * Standard-library prototype methods. A member call whose name is one of these only filters out
 * after every resolution tier failed, i.e. no declaration anywhere in the project exposed it -
 * so the callee could only live on a platform prototype (`users.map`, `str.trim`, `db.set`,
 * `promise.then`). A method a project class actually declares is resolved earlier, and the tier-4
 * fallback never resolves a builtin name to an unrelated declaration (see `resolveMemberCall`),
 * so a user method named like a prototype always wins.
 */
const PROTOTYPE_METHODS = new Set([
  // Array / TypedArray
  'at', 'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach', 'includes', 'indexOf', 'join',
  'keys', 'lastIndexOf', 'map', 'pop', 'push', 'reduce', 'reduceRight', 'reverse', 'shift',
  'slice', 'some', 'sort', 'splice', 'toLocaleString', 'unshift', 'values',
  // String
  'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'localeCompare', 'match', 'matchAll',
  'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'search', 'split',
  'startsWith', 'substring', 'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase',
  'toUpperCase', 'trim', 'trimEnd', 'trimStart',
  // Map / Set / WeakMap / WeakSet
  'add', 'clear', 'delete', 'get', 'has', 'set',
  // Promise
  'catch', 'finally', 'then',
  // Object / Function / universal
  'apply', 'bind', 'call', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toString', 'valueOf',
  // Date
  'getDate', 'getDay', 'getFullYear', 'getHours', 'getMilliseconds', 'getMinutes', 'getMonth',
  'getSeconds', 'getTime', 'getUTCDate', 'getUTCDay', 'getUTCFullYear', 'getUTCHours',
  'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth', 'getUTCSeconds', 'setDate', 'setFullYear',
  'setHours', 'setMilliseconds', 'setMinutes', 'setMonth', 'setSeconds', 'setTime', 'setUTCDate',
  'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes', 'setUTCMonth',
  'setUTCSeconds', 'toDateString', 'toISOString', 'toJSON', 'toTimeString',
  // Number
  'toExponential', 'toFixed', 'toPrecision',
  // RegExp
  'exec', 'test',
]);

/** Bare function globals that are never reached as a qualifier (`setTimeout(...)`, `parseInt(...)`). */
const BARE_FUNCTION_GLOBALS = new Set([
  'alert', 'atob', 'btoa', 'cancelAnimationFrame', 'cancelIdleCallback', 'clearInterval',
  'clearTimeout', 'confirm', 'decodeURI', 'decodeURIComponent', 'encodeURI',
  'encodeURIComponent', 'escape', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'prompt',
  'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback', 'setInterval',
  'setTimeout', 'structuredClone', 'unescape',
]);

/**
 * Whether an unresolved call site names a host global at its root. Mirrors the JetBrains
 * `isBuiltinGlobal` gate: when the same file declares the function or imports the root identifier
 * the site is NOT noise (that check happens before this in the caller), so this only filters calls
 * whose root identifier is a genuine platform global. Member calls on locals are also filtered
 * when the called name is a standard-library prototype method - after a full resolution failure
 * the callee can only exist on the platform.
 */
export function isBuiltinGlobal(source: JsBoundSource, site: JsCallSite): boolean {
  if (source.outline.functionNamed(site.name) !== undefined) {return false;}
  if (source.outline.typeNamed(site.rootIdentifier) !== undefined) {return false;}
  if (source.outline.importFor(site.rootIdentifier) !== undefined) {return false;}
  if (site.qualifier === null) {
    return GLOBAL_QUALIFIERS.has(site.rootIdentifier) || BARE_FUNCTION_GLOBALS.has(site.name);
  }
  return GLOBAL_QUALIFIERS.has(site.rootIdentifier) || PROTOTYPE_METHODS.has(site.name);
}
