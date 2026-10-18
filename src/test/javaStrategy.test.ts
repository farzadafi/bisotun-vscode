import * as assert from 'assert';
import { JavaStrategy } from '../strategies/javaStrategy';

suite('JavaStrategy Unit Tests', () => {
    const javaStrategy = new JavaStrategy();

    test('extractTypeCandidates should filter annotations and primitives', () => {
        const javaCode = `
      @GetMapping("/chapters")
      public List<ChapterResponse> getChapters(@PathVariable int courseId) {
          ChapterProjection projection = repository.findProjectedById(courseId);
          return mapper.toResponse(projection);
      }
    `;

        const candidates = javaStrategy.extractTypeCandidates(javaCode);

        // بررسی اینکه کلاس‌های DTO/Projection استخراج شدند
        assert.ok(candidates.includes('ChapterResponse'), 'Should include ChapterResponse');
        assert.ok(candidates.includes('ChapterProjection'), 'Should include ChapterProjection');

        // بررسی اینکه انوتیشن‌ها، پریمیتیوها و کلمات کلیدی حذف شدند
        assert.strictEqual(candidates.includes('GetMapping'), false, 'Should exclude @GetMapping');
        assert.strictEqual(candidates.includes('PathVariable'), false, 'Should exclude @PathVariable');
        assert.strictEqual(candidates.includes('List'), false, 'Should exclude List');
        assert.strictEqual(candidates.includes('int'), false, 'Should exclude int');
    });

    test('supports should return true only for java', () => {
        assert.strictEqual(javaStrategy.supports('java'), true);
        assert.strictEqual(javaStrategy.supports('javascript'), false);
        assert.strictEqual(javaStrategy.supports('python'), false);
    });
});
