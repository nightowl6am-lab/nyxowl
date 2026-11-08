<?php
namespace App;

use Foo\Bar;

interface Greeter
{
    public function greet(string $name): string;
}

trait Loggable
{
    public function log(): void
    {
    }
}

enum Suit: string
{
    case Hearts = 'H';
}

abstract class Base
{
    abstract public function run(): void;
}

final class GreeterImpl extends Base implements Greeter
{
    private int $count = 0;

    public function __construct(int $count)
    {
        $this->count = $count;
    }

    public function greet(string $name): string
    {
        return "hi " . $name;
    }

    protected function helper(): void
    {
    }

    private function hidden(): void
    {
    }
}

function top_level(): void
{
}
