package app

import (
	"fmt"
	"unicode/utf8"

	"gxShell/backend/ai"
)

// Every chat turn resends the whole history, and one tool result may hold up
// to aiToolOutputLimit bytes. Results from the current turn (after the latest
// user message) keep a generous head and tail; older ones are cut harder,
// since the model already acted on them. Only the model-bound copy is
// compacted: the conversation the user sees keeps the full output.
const (
	aiRecentToolResultLimit = 32 * 1024
	aiOlderToolResultLimit  = 2 * 1024
)

func compactAiToolResults(messages []ai.Message) {
	lastUser := -1
	for i, message := range messages {
		if message.Role == "user" {
			lastUser = i
		}
	}
	for i := range messages {
		if messages[i].Role != "tool" {
			continue
		}
		limit := aiRecentToolResultLimit
		if i < lastUser {
			limit = aiOlderToolResultLimit
		}
		messages[i].Content = clipToolResult(messages[i].Content, limit)
	}
}

// clipToolResult keeps the head and tail of text within limit bytes and says
// how much was left out, so the model can ask for a narrower command instead
// of guessing at the missing part.
func clipToolResult(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	head := validUTF8Prefix(text[:limit*2/3])
	tail := validUTF8Suffix(text[len(text)-limit/3:])
	omitted := len(text) - len(head) - len(tail)
	return fmt.Sprintf("%s\n[gxShell: %d of %d bytes omitted from this tool output; run a narrower command such as grep, head or tail if the missing part is needed]\n%s", head, omitted, len(text), tail)
}

// The cuts may split a multi-byte rune; drop only that partial rune so the
// rest of the output, valid or not, is passed through unchanged.
func validUTF8Prefix(s string) string {
	for i := 1; i <= utf8.UTFMax && i <= len(s); i++ {
		if utf8.RuneStart(s[len(s)-i]) {
			if !utf8.FullRuneInString(s[len(s)-i:]) {
				s = s[:len(s)-i]
			}
			break
		}
	}
	return s
}

func validUTF8Suffix(s string) string {
	for i := 0; i < utf8.UTFMax-1 && len(s) > 0 && !utf8.RuneStart(s[0]); i++ {
		s = s[1:]
	}
	return s
}
