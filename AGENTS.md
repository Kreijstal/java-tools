# Generic JVM development

Keep agent guidance, runtime defaults, compiler policies and memory management
general. Application-specific profiles, launch priorities, datasets, measurement
hosts and artifact selections belong in the consuming or integration repository.

Before changing runtime defaults, establish a reproducible baseline and compare
the candidate repeatedly under the same constraints. Build experimental bundles
separately. Preserve the selected default artifact, and do not use a historical
peak as evidence of a repeatable improvement. Record validation commands, results
and any performance that has not been verified.

After compiler or runtime changes, run the narrowest relevant rebuild or test.
Preserve evaluation order, exception and monitor behavior, reference identity,
and supported execution fallbacks. Keep application-specific deobfuscation names
and preparation rules outside this repository.
