package gozxing

import "fmt"

type ReaderException interface {
	error
	readerException()
}

type readerException struct {
	exception
}

func WrapReaderException(e error) ReaderException {
	return readerException{
		wrapException("ReaderException", e),
	}
}

func (readerException) readerException() {}

type exception struct {
	msg  string
	next error
}

func newException(prefix string, args ...interface{}) exception {
	msg := prefix
	if len(args) > 0 {
		msg += ": " + fmt.Sprintf(args[0].(string), args[1:]...)
	}
	return exception{
		msg: msg,
	}
}

func wrapException(msg string, next error) exception {
	return exception{
		msg:  msg,
		next: next,
	}
}

func (e exception) Error() string {
	return e.msg
}

func (e exception) Unwrap() error {
	return e.next
}

