//go:build !linux

package main

import "fmt"

func main() { fmt.Println("vminit runs only inside a Linux microVM") }
