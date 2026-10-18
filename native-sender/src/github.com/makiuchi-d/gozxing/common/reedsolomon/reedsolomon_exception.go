package reedsolomon

import "strings"

type ReedSolomonException interface {
	error
	reedSolomonException()
}

type reedSolomonException struct {
	msg  string
	next error
}

func (reedSolomonException) reedSolomonException() {}

func (e reedSolomonException) Error() string {
	return e.msg
}

func (e reedSolomonException) Unwrap() error {
	return e.next
}

func NewReedSolomonException(msg string) ReedSolomonException {
	return reedSolomonException{
		msg: "ReedSolomonException: " + msg,
	}
}

func WrapReedSolomonException(err error) ReedSolomonException {
	msg := err.Error()
	if !strings.HasPrefix(msg, "ReedSolomonException") {
		msg = "ReedSolomonException: " + msg
	}

	return reedSolomonException{
		msg:  msg,
		next: err,
	}
}
