# Java Tools Makefile

.PHONY: help install build test clean ci

# Default target
help:
	@echo "Available targets:"
	@echo "  install     - Install Node.js dependencies"
	@echo "  build       - Compile Java sources"
	@echo "  test        - Run test suite"
	@echo "  clean       - Remove compiled class files"
	@echo "  ci          - Run complete CI pipeline"
	@echo "  help        - Show this help message"

install:
	npm install

build:
	npm run build:java

test: build
	npm test

clean:
	npm run clean

ci:
	npm run ci