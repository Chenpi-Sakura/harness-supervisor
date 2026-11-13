import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Worker text is untrusted. Raw HTML and automatic external image loads stay disabled. */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>,
    img: ({ alt }) => <span className="markdown-image">{alt || "图片"}</span>,
  }}>{text}</ReactMarkdown></div>;
}
