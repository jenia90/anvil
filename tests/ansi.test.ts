import { describe, expect, test } from "bun:test";
import { ansiToHtml, stripAnsi } from "../src/ansi";

describe("ansi", () => {
  test("escapes html in program output", () => {
    const html = ansiToHtml("<script>x</script> & \"q\"");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });

  test("maps a colour code to a span and closes on reset", () => {
    expect(ansiToHtml("\x1b[94mhi\x1b[0m!")).toBe('<span class="ansi-94">hi</span>!');
  });

  test("closes an open span at the end of the text", () => {
    expect(ansiToHtml("\x1b[91mred")).toBe('<span class="ansi-91">red</span>');
  });

  test("drops unsupported codes", () => {
    expect(ansiToHtml("\x1b[48;5;12mx\x1b[0m")).toBe("x");
  });

  test("stripAnsi removes all escape sequences", () => {
    expect(stripAnsi("\x1b[33m[stage-1] \x1b[0m\x1b[94mText\x1b[0m")).toBe("[stage-1] Text");
  });
});
