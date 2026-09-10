package termio

import (
	"io"

	"gxShell/backend/types"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
	"golang.org/x/text/transform"
)

func charset(value string) encoding.Encoding {
	switch types.NormalizeTerminalEncoding(value) {
	case "gbk":
		return simplifiedchinese.GBK
	case "gb18030":
		return simplifiedchinese.GB18030
	case "big5":
		return traditionalchinese.Big5
	case "windows-1252":
		return charmap.Windows1252
	default:
		return nil
	}
}

// DecoderReader converts a legacy server stream to UTF-8 for xterm and logs.
func DecoderReader(reader io.Reader, value string) io.Reader {
	if codec := charset(value); codec != nil {
		return transform.NewReader(reader, codec.NewDecoder())
	}
	return reader
}

// EncodeInput converts Unicode input from the renderer to the server charset.
func EncodeInput(value string, encodingName string) ([]byte, error) {
	if codec := charset(encodingName); codec != nil {
		return codec.NewEncoder().Bytes([]byte(value))
	}
	return []byte(value), nil
}
