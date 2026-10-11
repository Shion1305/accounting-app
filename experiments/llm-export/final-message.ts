type ResponseMessage = {
  type?: string;
  phase?: string | null;
  status?: string | null;
  content?: { type?: string; text?: string }[];
};

/** Commentary and truncated answers do not establish a completed final answer. */
export function hasQualifyingFinalMessage(response: {
  status?: string;
  output?: ResponseMessage[];
}): boolean {
  return (response.output ?? []).some(
    (item) =>
      item.type === "message" &&
      (item.phase === "final_answer" ||
        (item.phase == null && response.status === "completed")) &&
      (item.status === "completed" ||
        (item.status == null && response.status === "completed")) &&
      (item.content ?? []).some(
        (content) =>
          content.type === "output_text" &&
          typeof content.text === "string" &&
          content.text.trim().length > 0,
      ),
  );
}
