import { describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";

describe("read Unicode byte input", () => {
  const sample = "café — 日本 🙂 cafÃ©";

  for (const [name, read] of [
    ["stdin file", "read -r value < /in"],
    ["numeric file", "read -r -u 3 value 3< /in"],
    ["stdin heredoc", `read -r value <<'EOF'\n${sample}\nEOF`],
    ["numeric heredoc", `read -r -u 3 value 3<<'EOF'\n${sample}\nEOF`],
    [
      "named here-string",
      `: {input}<<< '${sample}'\nread -r -u "$input" value`,
    ],
  ]) {
    it(`decodes ${name} once before assigning text`, async () => {
      const env = new Bash({ files: { "/in": `${sample}\n` } });
      const result = await env.exec(`${read}\nprintf '%s' "$value" > /out`);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(
        await env.fs.readFileBuffer("/out"),
        "assigned Unicode bytes match the input text",
      ).toEqual(new TextEncoder().encode(sample));
    });
  }

  it("reads Unicode passed through exec stdin", async () => {
    const env = new Bash();
    const result = await env.exec(
      'read -r value; printf "%s" "$value" > /out',
      { stdin: `${sample}\n` },
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await env.fs.readFileBuffer("/out")).toEqual(
      new TextEncoder().encode(sample),
    );
  });

  it("keeps Unicode lines through a bare while read", async () => {
    const input = "é🙂\n日本Z\n";
    const env = new Bash({ files: { "/in": input } });
    const result = await env.exec(
      'while read -r value; do printf "%s\\n" "$value" >> /out; done < /in',
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await env.fs.readFileBuffer("/out")).toEqual(
      new TextEncoder().encode(input),
    );
  });

  for (const lines of [10, 20]) {
    it(`decodes only consumed bytes while reading ${lines} lines`, async () => {
      const input = "é\n".repeat(lines);
      const env = new Bash({ files: { "/in": input } });
      let decodedBytes = 0;
      const originalDecode = TextDecoder.prototype.decode;
      const decode = vi
        .spyOn(TextDecoder.prototype, "decode")
        .mockImplementation(function (this: TextDecoder, input, options) {
          if (this.fatal && this.ignoreBOM)
            decodedBytes += input?.byteLength ?? 0;
          return originalDecode.call(this, input, options);
        });
      try {
        const result = await env.exec(
          'while read -r value; do printf "%s\\n" "$value" >> /out; done < /in',
        );
        expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
        expect(await env.fs.readFileBuffer("/out")).toEqual(
          new TextEncoder().encode(input),
        );
        expect(decodedBytes, "read decodes the Unicode bytes").toBeGreaterThan(
          0,
        );
        expect(
          decodedBytes,
          "read does not decode the unread tail again",
        ).toBeLessThanOrEqual(new TextEncoder().encode(input).length);
      } finally {
        decode.mockRestore();
      }
    });
  }

  it("decodes a valid line before a later invalid byte", async () => {
    const env = new Bash({
      files: { "/in": new Uint8Array([0xc3, 0xa9, 0x0a, 0xff, 0x0a]) },
    });
    const result = await env.exec(
      'while read -r value; do printf "%s\\n" "$value" >> /out; done < /in',
    );
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    expect(await env.fs.readFileBuffer("/out")).toEqual(
      new TextEncoder().encode("é\nÿ\n"),
    );
  });

  it("falls back one byte at a time for invalid UTF-8 candidates", async () => {
    for (const bytes of [
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf0, 0x9f, 0x99],
    ]) {
      const env = new Bash({ files: { "/in": new Uint8Array(bytes) } });
      const result = await env.exec(
        'while read -r -N 1 value; do printf "%s" "$value" >> /out; done < /in',
      );
      expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
      expect(await env.fs.readFileBuffer("/out")).toEqual(
        new TextEncoder().encode(String.fromCharCode(...bytes)),
      );
    }
  });

  for (const option of ["", "-n 2"]) {
    it(`consumes a whole emoji delimiter with read ${option}`, async () => {
      const env = new Bash({ files: { "/in": "é🙂日本Z" } });
      const result = await env.exec(
        [
          "exec 3< /in; exec 4<&3",
          `read -r ${option} -d '🙂' -u 3 value`,
          'printf "%s" "$value" > /values',
          "cat <&4 > /rest",
        ].join("\n"),
      );
      expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
      expect(await env.fs.readFileBuffer("/values")).toEqual(
        new TextEncoder().encode("é"),
      );
      expect(await env.fs.readFileBuffer("/rest")).toEqual(
        new TextEncoder().encode("日本Z"),
      );
    });
  }

  for (const flag of ["-n", "-N"]) {
    it(`${flag} counts codepoints and advances shared aliases by bytes`, async () => {
      const env = new Bash({ files: { "/in": "é🙂日本Z" } });
      const result = await env.exec(
        [
          "exec 3< /in",
          "exec 4<&3",
          `read -r ${flag} 1 -u 3 first`,
          `read -r ${flag} 1 second <&4`,
          'printf "%s|%s" "$first" "$second" > /values',
          "cat <&3 > /rest",
        ].join("\n"),
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect
        .soft(await env.fs.readFileBuffer("/values"))
        .toEqual(new TextEncoder().encode("é|🙂"));
      expect(
        await env.fs.readFileBuffer("/rest"),
        "shared fd remainder starts after both Unicode characters",
      ).toEqual(new TextEncoder().encode("日本Z"));
    });

    it(`${flag} keeps the BOM and includes its bytes in the shared position`, async () => {
      const bom = String.fromCharCode(0xfeff);
      const env = new Bash({ files: { "/in": `${bom}é🙂Z` } });
      const result = await env.exec(
        [
          "exec 3< /in",
          "exec 4<&3",
          `read -r ${flag} 1 -u 4 first`,
          `read -r ${flag} 1 -u 3 second`,
          'printf "%s%s" "$first" "$second" > /values',
          "cat <&4 > /rest",
        ].join("\n"),
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(await env.fs.readFileBuffer("/values")).toEqual(
        new TextEncoder().encode(`${bom}é`),
      );
      expect(await env.fs.readFileBuffer("/rest")).toEqual(
        new TextEncoder().encode("🙂Z"),
      );
    });

    it(`${flag} keeps raw-byte offsets when invalid UTF-8 falls back to text`, async () => {
      const env = new Bash({
        files: { "/in": new Uint8Array([0xff, 0xc3, 0xa9, 0x5a]) },
      });
      const result = await env.exec(
        [
          "exec 3< /in",
          "exec 4<&3",
          `read -r ${flag} 1 -u 3 first`,
          `read -r ${flag} 1 -u 4 second`,
          'printf "%s|%s" "$first" "$second" > /values',
          "cat <&3 > /rest",
        ].join("\n"),
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      // Invalid bytes keep the text fallback; read is not a binary copy.
      expect(await env.fs.readFileBuffer("/values")).toEqual(
        new TextEncoder().encode("ÿ|é"),
      );
      expect(await env.fs.readFileBuffer("/rest")).toEqual(
        new TextEncoder().encode("Z"),
      );
    });

    it(`${flag} reports EOF after fewer Unicode characters than requested`, async () => {
      const env = new Bash({ files: { "/in": "é🙂" } });
      const result = await env.exec(
        `read -r ${flag} 3 value < /in; printf '%s' "$?"; printf '%s' "$value" > /out`,
      );
      expect(result.stdout).toBe("1");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(await env.fs.readFileBuffer("/out")).toEqual(
        new TextEncoder().encode("é🙂"),
      );
    });
  }

  it("keeps group stdin as bytes between partial reads", async () => {
    const env = new Bash({ files: { "/in": "é🙂Z" } });
    const result = await env.exec(
      [
        "cat /in | {",
        "read -r -n 1 first",
        "read -r -N 1 second",
        "read -r -N 1 third",
        'printf "%s|%s|%s" "$first" "$second" "$third" > /out',
        "}",
      ].join("\n"),
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await env.fs.readFileBuffer("/out")).toEqual(
      new TextEncoder().encode("é|🙂|Z"),
    );
  });

  it("counts complete emoji bytes at the read string limit", async () => {
    const env = new Bash({
      files: { "/in": "🙂🙂\n" },
      executionLimits: { maxStringLength: 8 },
    });
    const result = await env.exec(
      'read -r value < /in; printf "%s" "$value" > /out',
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await env.fs.readFileBuffer("/out")).toEqual(
      new TextEncoder().encode("🙂🙂"),
    );
  });

  it("advances the descriptor behind group stdin by consumed bytes", async () => {
    const env = new Bash({ files: { "/in": "é🙂Z" } });
    const result = await env.exec(
      [
        "exec 3< /in",
        "{ read -r -n 1 first; read -r -N 1 second; } <&3",
        'printf "%s|%s" "$first" "$second" > /values',
        "cat <&3 > /rest",
      ].join("\n"),
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await env.fs.readFileBuffer("/values")).toEqual(
      new TextEncoder().encode("é|🙂"),
    );
    expect(await env.fs.readFileBuffer("/rest")).toEqual(
      new TextEncoder().encode("Z"),
    );
  });

  for (const option of ["", "-n 2"]) {
    it(`counts skipped escapes in the byte position with read ${option}`, async () => {
      const env = new Bash({ files: { "/in": "é\\\n\\🙂;尾" } });
      const result = await env.exec(
        [
          "exec 3< /in",
          `read ${option || "-d ';'"} -u 3 value`,
          'printf "%s" "$value" > /values',
          "cat <&3 > /rest",
        ].join("\n"),
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(await env.fs.readFileBuffer("/values")).toEqual(
        new TextEncoder().encode("é🙂"),
      );
      expect(await env.fs.readFileBuffer("/rest")).toEqual(
        new TextEncoder().encode(option ? ";尾" : "尾"),
      );
    });
  }
});
