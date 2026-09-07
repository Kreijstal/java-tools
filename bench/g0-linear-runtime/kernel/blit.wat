;; Hand-written ck.a(III[I[IIIIIIIIII)V: additive-saturating sprite blit with
;; per-pixel intensity scale. Arrays live in linear memory: dst at $dst, src at
;; $src (byte addresses of element 0). Same argument order as the bytecode's
;; locals 5..13: srcIdx, dstIdx, negW, negH, dstStep, srcStep, alpha.
(module
  (memory (export "mem") 64)
  (func (export "blit")
    (param $dst i32) (param $src i32)
    (param $si i32) (param $di i32) (param $negW i32) (param $negH i32)
    (param $dstStep i32) (param $srcStep i32) (param $alpha i32)
    (local $y i32) (local $x i32) (local $p i32) (local $l1 i32) (local $d i32) (local $s i32) (local $l0 i32)
    (local $sp i32) (local $dp i32)
    (local.set $y (i32.sub (i32.const 0) (local.get $negH)))
    (local.set $sp (i32.add (local.get $src) (i32.shl (local.get $si) (i32.const 2))))
    (local.set $dp (i32.add (local.get $dst) (i32.shl (local.get $di) (i32.const 2))))
    (block $doneRows
      (loop $rows
        (br_if $doneRows (i32.ge_s (local.get $y) (i32.const 0)))
        (local.set $x (i32.sub (i32.const 0) (local.get $negW)))
        (block $doneCols
          (loop $cols
            (br_if $doneCols (i32.ge_s (local.get $x) (i32.const 0)))
            (local.set $p (i32.load (local.get $sp)))
            (local.set $sp (i32.add (local.get $sp) (i32.const 4)))
            (if (local.get $p)
              (then
                (local.set $l1 (i32.mul (i32.and (local.get $p) (i32.const 0xFF00FF)) (local.get $alpha)))
                (local.set $p (i32.shr_u
                  (i32.add (i32.and (local.get $l1) (i32.const 0xFF00FF00))
                           (i32.and (i32.sub (i32.mul (local.get $p) (local.get $alpha)) (local.get $l1)) (i32.const 0xFF0000)))
                  (i32.const 8)))
                (local.set $d (i32.load (local.get $dp)))
                (local.set $s (i32.add (local.get $p) (local.get $d)))
                (local.set $l0 (i32.add (i32.and (local.get $p) (i32.const 0xFF00FF)) (i32.and (local.get $d) (i32.const 0xFF00FF))))
                (local.set $l1 (i32.add (i32.and (local.get $l0) (i32.const 0x1000100))
                                        (i32.and (i32.sub (local.get $s) (local.get $l0)) (i32.const 0x10000))))
                (i32.store (local.get $dp)
                  (i32.or (i32.sub (local.get $s) (local.get $l1))
                          (i32.sub (local.get $l1) (i32.shr_u (local.get $l1) (i32.const 8)))))))
            (local.set $dp (i32.add (local.get $dp) (i32.const 4)))
            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $cols)))
        (local.set $dp (i32.add (local.get $dp) (i32.shl (local.get $dstStep) (i32.const 2))))
        (local.set $sp (i32.add (local.get $sp) (i32.shl (local.get $srcStep) (i32.const 2))))
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $rows)))))
