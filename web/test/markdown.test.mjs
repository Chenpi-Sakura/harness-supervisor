import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/Markdown.tsx";

const render = text => renderToStaticMarkup(React.createElement(Markdown, { text }));

test("renders task headings, code and GFM tables", () => {
  const html = render("# Result\n\n**Complete** and `code`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```");
  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /<strong>Complete<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /language-js/);
});

test("untrusted Markdown cannot execute HTML, dangerous URLs or load remote images", () => {
  const html = render('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![private](https://example.com/track.png)\n\n[docs](https://example.com/docs)');
  assert.doesNotMatch(html, /<script|javascript:|<img|track\.png/);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("HTML and XML wrappers remain readable as escaped source", () => {
  assert.match(render('<task>\nImportant instructions\n</task>'), /Important instructions/);
  assert.match(render('<div>Important instructions</div>'), /&lt;div&gt;Important instructions&lt;\/div&gt;/);
});
