import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptEmailCompletion,
  canShowEmailCompletion,
  classifyEmailCompletionResponse,
  emailCompletionSuffix,
  isEmailCompletionCaretAtEnd,
  shouldRequestEmailCompletion,
  shouldScheduleEmailCompletion,
} from "./completion";

test("shows and accepts the exact same inline email completion", () => {
  const body = "Thanks for checking";
  const completion = "I will follow up tomorrow.";
  assert.equal(
    emailCompletionSuffix(body, completion),
    " I will follow up tomorrow.",
  );
  assert.equal(
    acceptEmailCompletion(body, completion),
    "Thanks for checking I will follow up tomorrow.",
  );
});

test("completion spacing respects whitespace and punctuation", () => {
  assert.equal(emailCompletionSuffix("Thanks, ", "Carlos"), "Carlos");
  assert.equal(emailCompletionSuffix("Thanks", "."), ".");
  assert.equal(emailCompletionSuffix("", "Hello"), "Hello");
  assert.equal(emailCompletionSuffix("Thanks", "   "), "");
});

test("empty or unusable model output is a normal no-suggestion result", () => {
  assert.equal(
    classifyEmailCompletionResponse({
      body: "Thanks for checking",
      completion: "",
    }),
    "no_suggestion",
  );
  assert.equal(
    classifyEmailCompletionResponse({
      body: "Thanks for checking",
      completion: "Thanks for checking",
      status: "suggestion",
    }),
    "no_suggestion",
  );
  assert.equal(
    classifyEmailCompletionResponse({
      body: "Thanks for checking",
      completion: "I will follow up tomorrow.",
      status: "suggestion",
    }),
    "suggestion",
  );
});

test("completion strips a model response that repeats the existing draft", () => {
  assert.equal(
    emailCompletionSuffix(
      "Thanks for checking",
      "Thanks for checking. I will follow up tomorrow.",
    ),
    ". I will follow up tomorrow.",
  );
  assert.equal(
    emailCompletionSuffix(
      "Hello Carlos,\n\nThanks for checking",
      "Thanks for checking and sending this over.",
    ),
    " and sending this over.",
  );
  assert.equal(
    emailCompletionSuffix("Thanks for checking", "Thanks for checking"),
    "",
  );
});

test("completion depends on current content and an end-positioned caret", () => {
  const currentBody = "Hello Carlos,\n\nThank you";
  assert.equal(
    canShowEmailCompletion({
      requestedBody: currentBody,
      currentBody,
      selectionStart: currentBody.length,
      selectionEnd: currentBody.length,
    }),
    true,
  );
  assert.equal(
    canShowEmailCompletion({
      requestedBody: "Hello Carlos,\n\nThank",
      currentBody,
      selectionStart: currentBody.length,
      selectionEnd: currentBody.length,
    }),
    false,
  );
  assert.equal(
    canShowEmailCompletion({
      requestedBody: currentBody,
      currentBody,
      selectionStart: 5,
      selectionEnd: 5,
    }),
    false,
  );
});

test("completion supports list entry editing without completing blank lines", () => {
  assert.equal(
    shouldRequestEmailCompletion("Here are the requested items:\n-project timeline"),
    true,
  );
  assert.equal(
    shouldRequestEmailCompletion("Here are the requested items:\n- project timeline"),
    true,
  );
  assert.equal(
    shouldRequestEmailCompletion("Here are the requested items:\n1. budget"),
    true,
  );
  assert.equal(
    shouldRequestEmailCompletion("Here are the requested items:\n"),
    false,
  );
  assert.equal(
    shouldRequestEmailCompletion("Thanks for sending the requested details"),
    true,
  );
  assert.equal(
    acceptEmailCompletion("-abc\n-xyc", "matches by reference"),
    "-abc\n-xyc matches by reference",
  );
});

test("completion scheduling follows composer focus instead of document focus", () => {
  const body = "Thanks for sending the requested details";
  assert.equal(
    shouldScheduleEmailCompletion({
      body,
      bodyHtml: null,
      focused: true,
      selectionStart: body.length,
      selectionEnd: body.length,
    }),
    true,
  );
  assert.equal(
    shouldScheduleEmailCompletion({
      body,
      bodyHtml: null,
      focused: false,
      selectionStart: body.length,
      selectionEnd: body.length,
    }),
    false,
  );
  assert.equal(
    shouldScheduleEmailCompletion({
      body,
      bodyHtml: "<p>Thanks for sending the requested details</p>",
      focused: true,
      selectionStart: body.length,
      selectionEnd: body.length,
    }),
    false,
  );
  assert.equal(
    shouldScheduleEmailCompletion({
      body,
      bodyHtml: null,
      focused: true,
      selectionStart: 6,
      selectionEnd: 6,
    }),
    false,
  );
});

test("caret checks use the textarea's live value after a newline", () => {
  const liveBody = "-abc\n";
  assert.equal(
    isEmailCompletionCaretAtEnd({
      body: liveBody,
      selectionStart: liveBody.length,
      selectionEnd: liveBody.length,
    }),
    true,
  );
  assert.equal(
    isEmailCompletionCaretAtEnd({
      body: liveBody,
      selectionStart: 4,
      selectionEnd: 4,
    }),
    false,
  );
});
