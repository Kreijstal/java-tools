# CI/CD Configuration

This repository includes Continuous Integration (CI) setup using GitHub Actions.

## Build Requirements

### Software Dependencies
- **Node.js** (v18.x or v20.x)
- **Java JDK** (v11 or v17)
- **npm** (comes with Node.js)

### Build Process
1. Install Node.js dependencies: `npm install`
2. Compile Java source files: `npm run build:java`
3. Run test suite: `npm test`

## Available NPM Scripts

- `npm run build:java` - Compile Java sources to bytecode
- `npm run build` - Full build (compiles Java)
- `npm test` - Run test suite (automatically builds Java first)
- `npm run clean` - Remove compiled .class files
- `npm run ci` - Complete CI pipeline (build + test)

## GitHub Actions Workflow

The CI workflow runs on:
- Push to `main` or `master` branches
- Pull requests targeting `main` or `master` branches

### Test Matrix
- Node.js versions: 18.x, 20.x
- Java versions: 11, 17

### Workflow Steps
1. Checkout source code
2. Set up Node.js and Java environments
3. Install dependencies with caching
4. Compile Java sources
5. Run test suite
6. Upload build artifacts

## Local Development

Use the provided Makefile for local development:

```bash
make install  # Install dependencies
make build    # Compile Java sources
make test     # Run tests
make clean    # Clean compiled files
make ci       # Run full CI pipeline
```

## Test Files

The project includes comprehensive tests that verify:
- JVM execution of various Java bytecode operations
- Arithmetic operations (add, subtract, multiply, divide, modulo)
- Constant loading instructions
- Method invocation and static calls
- Type parsing and descriptor conversion

All tests require compiled Java class files, which are automatically generated during the build process.