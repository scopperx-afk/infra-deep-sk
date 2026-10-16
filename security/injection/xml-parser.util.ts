/**
 * XXE-safe XML parser — Security spec §14.
 *
 * `fast-xml-parser` never resolves EXTERNAL entities (it does no I/O), but it can expand
 * INTERNAL ones — the "billion laughs" memory bomb — when entity processing is on. Defence
 * here is twofold:
 *   1. `processEntities: false` — no entity expansion at all.
 *   2. The returned parser REFUSES any document containing a `<!DOCTYPE` or `<!ENTITY`
 *      declaration (400) before parsing begins. A legitimate API payload has no DTD; its
 *      presence is the attack. (Spec test: "the XXE parser rejects a `<!ENTITY>` declaration".)
 * Input is also length-bounded.
 */
import { BadRequestException } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';

const DEFAULT_MAX_INPUT_CHARS = 1_048_576; // 1 MiB; HTTP's bodyLimit is the primary bound
const DTD_RE = /<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)\b/i;

class SafeXmlParser extends XMLParser {
  constructor(private readonly maxInputChars: number) {
    super({
      processEntities: false,
      ignoreDeclaration: true, // the `<?xml … ?>` prolog
      ignorePiTags: true, // processing instructions
      allowBooleanAttributes: false,
    });
  }

  override parse(xmlData: string | Uint8Array, validationOption?: boolean | Record<string, unknown>): unknown {
    const text = typeof xmlData === 'string' ? xmlData : Buffer.from(xmlData).toString('utf8');
    if (text.length > this.maxInputChars) throw new BadRequestException('XML document is too large');
    if (DTD_RE.test(text)) throw new BadRequestException('XML DTD and entity declarations are not allowed');
    return super.parse(text, validationOption as never);
  }
}

export function createSafeXmlParser(options?: { readonly maxInputChars?: number }): XMLParser {
  return new SafeXmlParser(options?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS);
}
